import dataclasses
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from dsh_gateway.app import create_app
from dsh_gateway.config import load_settings
from dsh_gateway.policy import OVERLAY_PATH, POLICY_PATH
from dsh_gateway.proxy import GATEWAY_COOKIE
from dsh_gateway.usage import UsageMeter

from .conftest import FakeBackend


@pytest.fixture
def backend():
    return FakeBackend()


@pytest.fixture
def client(tmp_path, backend):
    settings = dataclasses.replace(
        load_settings(), state_dir=tmp_path / "state", db_path=tmp_path / "gw.db", web_dist=tmp_path / "dist",
        admin_username="root", admin_password="rootpass1", deepseek_api_key="sk-shared-key-123456",
        secret_key="test-secret",
    )
    with TestClient(create_app(settings, backend)) as c:
        yield c


def login(client, username, password):
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return response


def test_bootstrap_admin_and_login_flow(client):
    assert client.get("/api/me").status_code == 401
    assert client.post("/api/auth/login", json={"username": "root", "password": "wrong"}).status_code == 401
    login(client, "root", "rootpass1")
    me = client.get("/api/me").json()
    assert me["role"] == "admin" and me["group_name"] == "default"
    client.post("/api/auth/logout")
    assert client.get("/api/me").status_code == 401


def test_admin_api_rejects_ordinary_users(client):
    login(client, "root", "rootpass1")
    assert client.post("/api/admin/users", json={"username": "alice", "password": "alicepass"}).status_code == 201
    client.cookies.clear()
    login(client, "alice", "alicepass")
    assert client.get("/api/admin/users").status_code == 403


def test_disabling_a_user_ends_their_sessions(client):
    login(client, "root", "rootpass1")
    alice = client.post("/api/admin/users", json={"username": "alice", "password": "alicepass"}).json()
    admin_cookie = client.cookies.get(GATEWAY_COOKIE)
    client.cookies.clear()
    login(client, "alice", "alicepass")
    alice_cookie = client.cookies.get(GATEWAY_COOKIE)
    client.cookies.set(GATEWAY_COOKIE, admin_cookie)
    assert client.patch(f"/api/admin/users/{alice['id']}", json={"disabled": True}).status_code == 200
    client.cookies.set(GATEWAY_COOKIE, alice_cookie)
    assert client.get("/api/me").status_code == 401
    client.cookies.clear()
    assert client.post("/api/auth/login", json={"username": "alice", "password": "alicepass"}).status_code == 403


def test_last_admin_cannot_be_removed(client):
    login(client, "root", "rootpass1")
    me = client.get("/api/me").json()
    response = client.patch(f"/api/admin/users/{me['id']}", json={"role": "user"})
    assert response.status_code == 400


def test_assigned_plugins_reach_the_sandbox_files(client, backend):
    login(client, "root", "rootpass1")
    bundle = client.post("/api/admin/plugins", json={
        "key": "codex", "kind": "bundle", "name": "Codex", "config": {"spec": "@deepseek-ai/dsh-subagent-codex@0.2.1-rc.2"},
    }).json()
    mcp = client.post("/api/admin/plugins", json={
        "key": "memory", "kind": "mcp", "name": "Memory",
        "config": {
            "serverName": "memory", "transport": "stdio", "command": "mcp-server-memory", "env": {"A": "1"},
            "install": "@modelcontextprotocol/server-memory@2026.7.4",
        },
    }).json()
    bad = client.post("/api/admin/plugins", json={
        "key": "bad", "kind": "mcp", "name": "Bad", "config": {"serverName": "x y", "transport": "stdio"},
    })
    assert bad.status_code == 400
    groups = client.get("/api/admin/groups").json()
    client.patch(f"/api/admin/groups/{groups[0]['id']}", json={"plugin_ids": [bundle["id"]], "mem_limit": "1g"})
    me = client.get("/api/me").json()
    client.patch(f"/api/admin/users/{me['id']}", json={"plugin_ids": [mcp["id"]]})

    client.post("/api/me/sandbox/start")
    (spec,) = [s for s in backend.live.values()]
    policy = json.loads(spec.files[POLICY_PATH])
    assert policy["bundles"] == [{"key": "codex", "spec": "@deepseek-ai/dsh-subagent-codex@0.2.1-rc.2"}]
    assert policy["npm"] == [{"key": "memory", "spec": "@modelcontextprotocol/server-memory@2026.7.4"}]
    overlay = spec.files[OVERLAY_PATH].decode()
    assert '"serverName": "memory"' in overlay and "dsh-cloud-mcp-memory" in overlay
    assert "install" not in overlay
    assert spec.resources.mem_limit == "1g"


def test_model_proxy_uses_user_key_and_enforces_group_limits(client, backend, monkeypatch):
    login(client, "root", "rootpass1")
    groups = client.get("/api/admin/groups").json()
    client.patch(f"/api/admin/groups/{groups[0]['id']}", json={"daily_request_limit": 1, "allowed_models": ["deepseek-chat"]})
    client.put("/api/me/api-key", json={"api_key": "sk-user-own-key-9999"})
    client.post("/api/me/sandbox/start")
    (spec,) = backend.live.values()
    token = spec.env["DEEPSEEK_API_KEY"]

    seen = []

    async def fake_send(request, stream=False):
        seen.append(request.headers["x-api-key"])
        body = b'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n' \
               b'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n'
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"}, request=request)

    monkeypatch.setattr(client.app.state.llm_http, "send", fake_send)
    headers = {"x-api-key": token}
    denied = client.post("/llm/anthropic/v1/messages", headers=headers, json={"model": "other"})
    assert denied.status_code == 403
    ok = client.post("/llm/anthropic/v1/messages", headers=headers, json={"model": "deepseek-chat"})
    assert ok.status_code == 200
    assert seen == ["sk-user-own-key-9999"]
    limited = client.post("/llm/anthropic/v1/messages", headers=headers, json={"model": "deepseek-chat"})
    assert limited.status_code == 429
    usage = {u["username"]: u["usage_today"] for u in client.get("/api/admin/users").json()}
    assert usage["root"] == {"requests": 1, "input_tokens": 7, "output_tokens": 3}
    assert client.post("/llm/anthropic/v1/messages", headers={"x-api-key": "dshgw-forged"}, json={}).status_code == 401


def test_model_api_network_failures_become_errors_dsh_can_retry(client, backend, monkeypatch):
    login(client, "root", "rootpass1")
    client.put("/api/me/api-key", json={"api_key": "sk-user-own-key-9999"})
    client.post("/api/me/sandbox/start")
    (spec,) = backend.live.values()
    headers = {"x-api-key": spec.env["DEEPSEEK_API_KEY"]}

    async def unreachable(request, stream=False):
        raise httpx.ReadError("[SSL] record layer failure", request=request)

    monkeypatch.setattr(client.app.state.llm_http, "send", unreachable)
    failed = client.post("/llm/anthropic/v1/messages", headers=headers, json={"model": "deepseek-chat"})
    assert failed.status_code == 502
    assert "ReadError" in failed.json()["error"]["message"]

    class Dropped(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n'
            raise httpx.ReadError("connection reset")

    async def drops_midway(request, stream=False):
        return httpx.Response(200, stream=Dropped(), headers={"content-type": "text/event-stream"}, request=request)

    monkeypatch.setattr(client.app.state.llm_http, "send", drops_midway)
    partial = client.post("/llm/anthropic/v1/messages", headers=headers, json={"model": "deepseek-chat"})
    assert partial.status_code == 200 and partial.content.startswith(b"data: ")


async def test_usage_meter_reads_plain_json_bodies():
    recorded = []
    meter = UsageMeter(lambda i, o: recorded.append((i, o)))

    async def body():
        yield b'{"usage": {"prompt_tokens": 5, '
        yield b'"completion_tokens": 2}}'

    assert b"".join([c async for c in meter.observe(body())]).startswith(b'{"usage"')
    assert recorded == [(5, 2)]


def test_admin_password_reset_switch(tmp_path, backend):
    base = dataclasses.replace(
        load_settings(), state_dir=tmp_path / "state", db_path=tmp_path / "gw.db", web_dist=tmp_path / "dist",
        admin_username="root", admin_password="first-pass", secret_key="s",
    )
    with TestClient(create_app(base, backend)):
        pass
    reset = dataclasses.replace(base, admin_password="second-pass", admin_reset_password=True)
    with TestClient(create_app(reset, backend)) as c:
        assert c.post("/api/auth/login", json={"username": "root", "password": "first-pass"}).status_code == 401
        login(c, "root", "second-pass")
    unchanged = dataclasses.replace(base, admin_password="third-pass")
    with TestClient(create_app(unchanged, backend)) as c:
        login(c, "root", "second-pass")


def test_sleeping_workspace_sends_pages_to_the_launch_page_and_never_wakes_on_fetch(client, backend):
    login(client, "root", "rootpass1")
    page = client.get("/u/root/session/1?x=2", headers={"sec-fetch-mode": "navigate"}, follow_redirects=False)
    assert page.status_code == 303
    assert page.headers["location"] == "/?next=%2Fu%2Froot%2Fsession%2F1%3Fx%3D2"
    fetch = client.get("/u/root/api/state", headers={"sec-fetch-mode": "cors"}, follow_redirects=False)
    assert fetch.status_code == 503
    assert backend.live == {}
    assert client.get("/api/me").json()["workspace_saved"] is False


def test_group_image_must_match_the_default_and_reaches_the_sandbox(client, backend):
    base = backend.images[None]
    backend.images["team/ds:1"] = {**base}
    backend.images["team/old:1"] = {**base, "dsh-cloud.dsh-version": "0.1.0"}
    backend.images["random/ubuntu"] = {}
    login(client, "root", "rootpass1")

    assert "不是工作空间镜像" in client.post("/api/admin/images", json={"name": "u", "ref": "random/ubuntu"}).json()["detail"]
    assert "dsh 版本" in client.post("/api/admin/images", json={"name": "o", "ref": "team/old:1"}).json()["detail"]
    assert client.post("/api/admin/images", json={"name": "x", "ref": "team/missing:1"}).status_code == 400
    image = client.post("/api/admin/images", json={"name": "数据科学", "ref": "team/ds:1"}).json()
    assert image["dsh_version"] == "0.2.1-rc.2"
    assert client.patch(f"/api/admin/images/{image['id']}", json={"ref": "team/ds:2"}).status_code == 400

    group = client.get("/api/admin/groups").json()[0]
    client.patch(f"/api/admin/groups/{group['id']}", json={"image_id": image["id"]})
    assert client.delete(f"/api/admin/images/{image['id']}").status_code == 400
    client.post("/api/me/sandbox/start")
    (spec,) = backend.live.values()
    assert spec.image == "team/ds:1"
    assert client.get("/api/me/sandbox").json()["image"] == "team/ds:1"

    client.patch(f"/api/admin/groups/{group['id']}", json={"image_id": 0})
    assert client.get("/api/admin/groups").json()[0]["image_id"] is None
    assert client.delete(f"/api/admin/images/{image['id']}").status_code == 200


def test_version_1_database_is_migrated(tmp_path):
    import sqlite3

    from dsh_gateway.db import _SCHEMA, Database

    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.executescript(_SCHEMA)
    old.execute(
        "INSERT INTO groups (name, mem_limit, cpus, idle_timeout_s, max_lifetime_s) VALUES ('default', '2g', 2, 900, 3600)"
    )
    old.execute("PRAGMA user_version=1")
    old.commit()
    old.close()

    db = Database(path)
    (group,) = db.list_groups()
    assert group["name"] == "default" and group["image_id"] is None
    assert db.list_images() == []
    assert sorted(p["key"] for p in db.list_plugins()) == ["rag-kb", "workspace-browser", "workspace-upload"]
    assert len(group["plugin_ids"]) == 3
    db.close()
    assert sqlite3.connect(path).execute("PRAGMA user_version").fetchone()[0] == 4


def test_built_in_plugins_are_registered_once_and_keep_admin_edits(tmp_path):
    import sqlite3

    from dsh_gateway.db import _SCHEMA, Database

    path = tmp_path / "gateway.db"
    old = sqlite3.connect(path)
    old.executescript(_SCHEMA)
    old.execute(
        "INSERT INTO groups (name, mem_limit, cpus, idle_timeout_s, max_lifetime_s) VALUES ('default', '2g', 2, 900, 3600)"
    )
    old.execute(
        "INSERT INTO users (username, password_hash, role, group_id, created_at) VALUES ('ann', 'x', 'user', 1, 0)"
    )
    # An admin registered the knowledge base earlier and gave it to one user only.
    old.execute(
        "INSERT INTO plugins (key, kind, name, config) VALUES ('rag-kb', 'bundle', 'KB', '{\"spec\": \"@puwenhui/dsh-rag-kb\"}')"
    )
    old.execute("INSERT INTO user_plugins VALUES (1, 1)")
    old.execute("PRAGMA user_version=1")
    old.commit()
    old.close()

    db = Database(path)
    plugins = {p["key"]: p for p in db.list_plugins()}
    assert plugins["rag-kb"]["config"] == {"spec": "@puwenhui/dsh-rag-kb"}
    (group,) = db.list_groups()
    assert group["plugin_ids"] == [plugins["workspace-browser"]["id"], plugins["workspace-upload"]["id"]]

    db.delete_plugin(plugins["workspace-browser"]["id"])
    db.close()
    assert [p["key"] for p in Database(path).list_plugins()] == ["rag-kb", "workspace-upload"]


def test_an_upgrade_adds_only_the_built_in_plugins_its_version_introduced(tmp_path):
    from dsh_gateway.db import Database

    path = tmp_path / "gateway.db"
    db = Database(path)
    group_id = db.ensure_default_group({"mem_limit": "2g", "cpus": 2, "idle_timeout_s": 900, "max_lifetime_s": 3600})
    plugins = {p["key"]: p["id"] for p in db.list_plugins()}
    # An admin took the knowledge base away from everyone and deleted the upload plugin, on schema 3.
    db.set_group_plugins(group_id, [plugins["workspace-browser"]])
    db.delete_plugin(plugins["workspace-upload"])
    db._conn.execute("PRAGMA user_version=3")
    db.close()

    db = Database(path)
    plugins = {p["key"]: p["id"] for p in db.list_plugins()}
    assert sorted(plugins[k] for k in ("workspace-browser", "workspace-upload")) == sorted(db.get_group(group_id)["plugin_ids"])


def test_a_new_gateway_gives_the_default_group_the_built_in_plugins(tmp_path):
    from dsh_gateway.db import Database

    db = Database(tmp_path / "gateway.db")
    group_id = db.ensure_default_group({"mem_limit": "2g", "cpus": 2, "idle_timeout_s": 900, "max_lifetime_s": 3600})
    keys = {p["id"]: p["key"] for p in db.list_plugins()}
    assert sorted(keys[i] for i in db.get_group(group_id)["plugin_ids"]) == ["rag-kb", "workspace-browser", "workspace-upload"]


def test_workspace_browser_socket_is_for_the_owner_only(client):
    from starlette.websockets import WebSocketDisconnect

    login(client, "root", "rootpass1")
    client.post("/api/admin/users", json={"username": "alice", "password": "alicepass"})
    for path, code in (("/u/alice/_dsh-cloud/browser", 4401), ("/u/root/_dsh-cloud/browser", 4404)):
        with pytest.raises(WebSocketDisconnect) as closed:
            with client.websocket_connect(path) as ws:
                ws.receive_text()
        assert closed.value.code == code


def test_knowledge_base_uploads_are_checked_before_they_reach_the_workspace(tmp_path, backend):
    settings = dataclasses.replace(
        load_settings(), state_dir=tmp_path / "state", db_path=tmp_path / "gw.db", web_dist=tmp_path / "dist",
        admin_username="root", admin_password="rootpass1", secret_key="test-secret",
        kb_max_file_bytes=100, kb_quota_bytes=150,
    )
    with TestClient(create_app(settings, backend)) as client:
        check_knowledge_base_uploads(client)


def test_files_panel_uploads_are_checked_before_they_reach_the_workspace(tmp_path, backend):
    settings = dataclasses.replace(
        load_settings(), state_dir=tmp_path / "state", db_path=tmp_path / "gw.db", web_dist=tmp_path / "dist",
        admin_username="root", admin_password="rootpass1", secret_key="test-secret",
        upload_max_file_bytes=100,
    )
    with TestClient(create_app(settings, backend)) as client:
        upload = lambda body: client.post("/u/root/api/dshCloudFiles/upload?session=s&path=a/b.bin", content=body)
        assert upload(b"x").status_code == 401
        login(client, "root", "rootpass1")
        assert client.get("/u/root/_dsh-cloud/files/limits").json() == {"maxFileBytes": 100}
        assert upload(b"x").status_code == 503
        client.post("/api/me/sandbox/start")
        forwarded = []

        def sandbox(request: httpx.Request) -> httpx.Response:
            forwarded.append((request.url.path, request.url.query, request.read()))
            return httpx.Response(201, stream=httpx.ByteStream(b"{}"))

        client.app.state.sandbox_http = httpx.AsyncClient(transport=httpx.MockTransport(sandbox))
        refused = upload(b"x" * 101)
        assert refused.status_code == 413 and refused.json() == {"code": "too-large", "limit": 100}
        assert upload(b"x" * 100).status_code == 201
        assert forwarded == [("/api/dshCloudFiles/upload", b"session=s&path=a/b.bin", b"x" * 100)]


def check_knowledge_base_uploads(client):
    login(client, "root", "rootpass1")
    client.post("/api/me/sandbox/start")
    forwarded = []

    def sandbox(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"usedBytes": 60})
        forwarded.append(request.read())
        return httpx.Response(202, stream=httpx.ByteStream(b"{}"))

    client.app.state.sandbox_http = httpx.AsyncClient(transport=httpx.MockTransport(sandbox))
    upload = lambda body: client.post("/u/root/api/dshCloudKb/upload?name=a.md", content=body)

    assert client.get("/u/root/_dsh-cloud/kb/limits").json() == {"maxFileBytes": 100, "quotaBytes": 150}
    assert upload(b"x" * 101).json()["code"] == "too-large"
    refused = upload(b"x" * 91)
    assert refused.status_code == 413 and refused.json()["code"] == "quota"
    assert upload(b"x" * 90).status_code == 202
    assert forwarded == [b"x" * 90]
