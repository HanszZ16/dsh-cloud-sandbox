import dataclasses
import json
import re
from urllib.parse import urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from dsh_gateway.app import create_app
from dsh_gateway.config import load_settings
from dsh_gateway.website_browser import PublicWebsite, WebsiteBrowserError

from .conftest import FakeBackend
from .test_api import login

GATEWAY = "https://dsh.example.test"
VAULT = "https://vault.example.test"
SITE = "https://work.example.test"
API = "/_dsh-cloud/website-login"
ORIGIN = {"Origin": VAULT}
HANDOFF_COOKIE = {
    "name": "session", "value": "issued-session-cookie", "path": "/", "expires": -1,
    "httpOnly": True, "sameSite": "Lax",
}


class BrowserBackend(FakeBackend):
    async def start(self, spec, progress):
        handle = await super().start(spec, progress)
        handle.browser_url = "http://browser-hub"
        return handle


@pytest.fixture
def service(tmp_path, monkeypatch):
    config = {
        "work": {"origin": SITE, "login_path": "/login", "success_path": "/home", "username_selector": "#name",
                 "password_selector": "#password", "submit_selector": "#submit", "cookies": ["session"]},
    }
    config["other"] = {**config["work"], "origin": "https://other.example.test"}
    sites = tmp_path / "sites.json"
    sites.write_text(json.dumps(config))
    settings = dataclasses.replace(
        load_settings(), state_dir=tmp_path / "state", db_path=tmp_path / "gw.db", web_dist=tmp_path / "dist",
        admin_username="root", admin_password="rootpass1", public_url=GATEWAY, website_login_origin=VAULT,
        website_login_sites_file=str(sites), website_login_vault_key="temporary-test-key" * 3,
    )
    seen = {"browser": [], "hub": []}

    async def browser(site, username, password):
        seen["browser"].append((site.origin, username, password))
        return [HANDOFF_COOKIE]

    async def hub(url, **kwargs):
        seen["hub"].append((url, kwargs))
        return httpx.Response(204)

    monkeypatch.setattr("dsh_gateway.website_login.sign_in", browser)
    with TestClient(create_app(settings, BrowserBackend()), base_url=GATEWAY) as client:
        monkeypatch.setattr(client.app.state.sandbox_http, "post", hub)
        gateway = client.app.state.gw
        login(client, "root", "rootpass1")
        alice = client.post("/api/admin/users", json={"username": "alice", "password": "alicepass"}).json()
        plugin = next(p["id"] for p in gateway.db.list_plugins() if p["key"] == "website-login")
        root = gateway.db.get_user_by_name("root")
        assert client.get("/api/me").json()["website_login"] == {"status": "unassigned", "vault_url": f"{VAULT}/"}
        gateway.db.set_user_plugins(root.id, [plugin])
        gateway.db.set_user_plugins(alice["id"], [plugin])
        client.portal.call(gateway.manager.ensure, root.username, gateway.policy_for(root))
        yield client, gateway, seen


def _start(client, gateway, call_id, site="work"):
    record = gateway.manager.get("root")
    agent = {"Authorization": f"Bearer {record.model_token}"}
    assert client.post(f"{API}/requests/{call_id}/{site}", headers=agent).json() == {"status": "pending"}
    owner = client.get(f"/u/root{API}/{call_id}").json()
    assert urlsplit(owner["form_url"]).netloc == "vault.example.test"
    return owner["form_url"], agent


def _authenticate(client, url, username="root", password="rootpass1"):
    return client.post(url, data={"action": "authenticate", "dsh_username": username, "dsh_password": password},
                       headers=ORIGIN, follow_redirects=False)


def test_only_the_confirmed_broker_receives_password_and_vault_is_scoped(service):
    client, gateway, seen = service
    assert client.get("/api/me").json()["website_login"] == {"status": "available", "vault_url": f"{VAULT}/"}
    form, agent = _start(client, gateway, "call_1")
    page = client.get(form)
    assert "验证 DSH 身份" in page.text
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    assert client.get(f"{VAULT}/api/me").status_code == 404
    assert _authenticate(client, form, "alice", "alicepass").status_code == 303
    assert client.get(form).status_code == 404
    assert _authenticate(client, form).status_code == 303

    credentials = {"action": "submit", "username": "web<alice>", "password": "not-for-the-workspace", "save": "1"}
    for invalid_origin in (GATEWAY, "null"):
        rejected = client.post(form, data=credentials, headers={"Origin": invalid_origin})
        assert rejected.status_code == 403 and "无法验证表单来源" in rejected.text
    assert seen == {"browser": [], "hub": []}
    response = client.post(form, data=credentials, headers=ORIGIN)
    assert response.status_code == 200 and credentials["password"] not in response.text
    assert seen["browser"] == [(SITE, "web<alice>", "not-for-the-workspace")]
    [(url, sent)] = seen["hub"]
    assert url == "http://browser-hub/_internal/website-session"
    assert sent["json"] == {"origin": SITE, "cookies": [HANDOFF_COOKIE]}
    assert client.get(f"{API}/requests/call_1", headers=agent).json() == {"status": "signed-in"}
    assert client.post(form, data=credentials, headers=ORIGIN).status_code == 409

    root = gateway.db.get_user_by_name("root")
    [saved] = gateway.db.website_credentials(root.id)
    assert saved == {"id": saved["id"], "origin": SITE, "username": "web<alice>"}
    assert credentials["password"] not in gateway.db.website_credential(root.id, saved["id"], SITE)["ciphertext"]
    assert "web&lt;alice&gt;" in client.get(f"{VAULT}/").text

    form, _ = _start(client, gateway, "call_2", "other")
    assert client.post(form, data={"action": "saved", "credential": saved["id"]}, headers=ORIGIN).status_code == 400
    assert len(seen["hub"]) == 1
    form, _ = _start(client, gateway, "call_3")
    assert client.post(form, data={"action": "saved", "credential": saved["id"]}, headers=ORIGIN).status_code == 200
    assert len(seen["hub"]) == 2
    assert seen["browser"][0] == seen["browser"][1]

    assert client.post(f"{VAULT}/", data={"action": "delete", "id": saved["id"]}, headers=ORIGIN).status_code == 200
    assert gateway.db.website_credentials(root.id) == []


def test_cancel_or_workspace_restart_refuses_late_submissions(service):
    client, gateway, seen = service
    form, agent = _start(client, gateway, "cancel")
    _authenticate(client, form)
    assert client.post(form, data={"action": "cancel"}, headers=ORIGIN).status_code == 200
    assert client.get(f"{API}/requests/cancel", headers=agent).json() == {"status": "cancelled"}
    assert client.post(form, data={"action": "submit", "username": "user", "password": "secret"}, headers=ORIGIN).status_code == 409

    form, _ = _start(client, gateway, "restart")
    client.portal.call(gateway.manager.release, "root", "test restart")
    assert client.get(form).status_code == 404
    assert client.get(f"{API}/requests/restart", headers=agent).status_code == 403
    assert seen == {"browser": [], "hub": []}


def test_embedded_form_authenticates_without_a_vault_cookie(service):
    client, gateway, seen = service
    form, agent = _start(client, gateway, "embedded")
    form += "?embed=1"
    page = client.get(form)
    assert "验证 DSH 身份" in page.text
    assert f"frame-ancestors {GATEWAY};" in page.headers["content-security-policy"]
    assert f"script-src {VAULT}/_form-layout.js;" in page.headers["content-security-policy"]
    assert 'data-parent-origin="https://dsh.example.test"' in page.text
    assert "frame-ancestors 'none';" in client.get(f"{VAULT}/?embed=1").headers["content-security-policy"]
    assert _authenticate(client, form, "alice", "alicepass").status_code == 404

    signed_in = _authenticate(client, form)
    assert signed_in.status_code == 200 and "set-cookie" not in signed_in.headers
    grant = re.search(r'name="grant" value="([A-Za-z0-9_-]+)"', signed_in.text).group(1)
    fields = {"action": "submit", "grant": grant, "username": "webuser", "password": "web-password", "save": "1"}

    another, _ = _start(client, gateway, "another")
    assert "验证 DSH 身份" in client.post(another + "?embed=1", data=fields, headers=ORIGIN).text
    assert client.post(form, data=fields, headers={"Origin": GATEWAY}).status_code == 403
    assert seen == {"browser": [], "hub": []}

    assert "已授权" in client.post(form, data=fields, headers=ORIGIN).text
    assert client.get(f"{API}/requests/embedded", headers=agent).json() == {"status": "signed-in"}
    assert len(seen["hub"]) == 1
    assert "验证 DSH 身份" in client.post(form, data=fields, headers=ORIGIN).text


def test_local_workspace_navigation_switches_to_the_only_allowed_parent(service):
    client, gateway, _ = service
    navigation = {"Sec-Fetch-Mode": "navigate"}
    response = client.get("http://localhost:8000/u/root/?next=chat", headers=navigation, follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == f"{GATEWAY}/u/root/?next=chat"
    assert client.get("http://localhost:8000/api/me", follow_redirects=False).status_code == 401
    assert client.get("http://host.docker.internal:8000/api/me", follow_redirects=False).status_code == 401
    _start(client, gateway, "secure_parent")
    assert client.get(f"/u/root{API}/secure_parent").json()["dsh_origin"] == GATEWAY


def test_login_failure_reports_which_browser_stage_failed(service, monkeypatch):
    client, gateway, seen = service
    form, _ = _start(client, gateway, "network_failure")
    _authenticate(client, form)
    fields = {"action": "submit", "username": "webuser", "password": "not-for-logs"}
    with monkeypatch.context() as network:
        async def failed_browser(*_args):
            raise WebsiteBrowserError("site-unreachable", "ERR_CONNECTION_CLOSED")

        network.setattr("dsh_gateway.website_login.sign_in", failed_browser)
        response = client.post(form, data=fields, headers=ORIGIN)
        assert response.status_code == 502 and "登录浏览器连不到目标网站" in response.text
        assert gateway.db.list_audit(1)[0]["detail"] == "site-unreachable: ERR_CONNECTION_CLOSED"
        assert seen["hub"] == []

    repeat, _ = _start(client, gateway, "handoff_failure")

    async def failed_hub(*_args, **_kwargs):
        return httpx.Response(404, text=fields["password"])

    monkeypatch.setattr(client.app.state.sandbox_http, "post", failed_hub)
    response = client.post(repeat, data=fields, headers=ORIGIN)
    assert response.status_code == 502 and "网站已登录，但工作区没有收到会话" in response.text
    assert gateway.db.list_audit(1)[0]["detail"] == "workspace-handoff: HTTP 404"


def test_public_login_url_does_not_need_a_site_alias(service, monkeypatch):
    client, gateway, seen = service
    agent = {"Authorization": f"Bearer {gateway.manager.get('root').model_token}"}
    path = f"{API}/requests/public_url"
    for url in ("http://example.com/login", "https://127.0.0.1/login", "https://web.local/login",
                "https://example.com:8443/login", "https://dsh.example.test/admin"):
        assert client.post(path, json={"login_url": url}, headers=agent).status_code == 400
    target = "https://login.example.com/sign-in?continue=%2Fdashboard"
    assert client.post(path, json={"login_url": target}, headers=agent).json() == {"status": "pending"}
    assert seen == {"browser": [], "hub": []}
    form = client.get(f"/u/root{API}/public_url").json()["form_url"]
    _authenticate(client, form)

    async def browser(site, username, password):
        assert site == PublicWebsite("https://login.example.com", target)
        assert (username, password) == ("webuser", "test-only")
        return [HANDOFF_COOKIE]

    monkeypatch.setattr("dsh_gateway.website_login.sign_in", browser)
    response = client.post(form, data={"action": "submit", "username": "webuser", "password": "test-only"}, headers=ORIGIN)
    assert response.status_code == 200
    assert seen["hub"][0][1]["json"]["origin"] == "https://login.example.com"


def test_native_vault_embeds_and_manages_credentials_without_third_party_cookies(service):
    client, gateway, _ = service
    url = f"{VAULT}/vault?embed=1"
    response = _authenticate(client, url)
    assert response.status_code == 200 and "set-cookie" not in response.headers
    assert "新建登录" in response.text and "搜索保险库" in response.text
    grant = re.search(r'name="grant" value="([A-Za-z0-9_-]+)"', response.text).group(1)
    owner_id = gateway.db.get_user_by_name("root").id
    fields = {"action": "save", "grant": grant, "site": "https://login.example.com/sign-in",
              "username": "example-user", "password": "do-not-show-this"}
    assert client.post(url, data=fields, headers={"Origin": GATEWAY}).status_code == 403
    response = client.post(url, data=fields, headers=ORIGIN)
    assert "example-user" in response.text and fields["password"] not in response.text
    [entry] = gateway.db.website_credentials(owner_id)
    stored = gateway.db.website_credential(owner_id, entry["id"], "https://login.example.com")["ciphertext"]
    assert fields["password"] not in stored
    changes = {"action": "replace", "grant": grant, "id": entry["id"], "password": "updated-demo-only"}
    assert "密码已更新" in client.post(url, data=changes, headers=ORIGIN).text
    assert gateway.db.website_credential(owner_id, entry["id"], "https://login.example.com")["ciphertext"] != stored
    assert "登录记录已删除" in client.post(url, data={**changes, "action": "delete"}, headers=ORIGIN).text
    assert not gateway.db.website_credentials(owner_id)
    assert "验证 DSH 身份" in client.post(url, data={"action": "logout", "grant": grant}, headers=ORIGIN).text
    assert "验证 DSH 身份" in client.post(url, data=fields, headers=ORIGIN).text
