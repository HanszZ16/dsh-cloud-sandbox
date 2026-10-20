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
