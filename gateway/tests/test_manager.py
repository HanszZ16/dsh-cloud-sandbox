import dataclasses

import pytest

from dsh_gateway.backends.base import SandboxBackend, SandboxHandle, SandboxSpec
from dsh_gateway.config import load_settings
from dsh_gateway.manager import SandboxManager
from dsh_gateway.store import LocalStateStore


class FakeBackend(SandboxBackend):
    name = "fake"

    def __init__(self, fail_capture: bool = False) -> None:
        self.live: dict[str, SandboxSpec] = {}
        self.fail_capture = fail_capture
        self.orphans: list[SandboxHandle] = []

    async def start(self, spec):
        sandbox_id = f"sbx-{len(self.live)}-{spec.user_id}"
        self.live[sandbox_id] = spec
        return SandboxHandle(sandbox_id=sandbox_id, user_id=spec.user_id, upstream_url="http://fake")

    async def launch_url(self, handle):
        return "http://fake/?token=t"

    async def capture(self, handle):
        if self.fail_capture:
            raise RuntimeError("disk unreadable")
        return {"home": f"state-of-{handle.user_id}".encode()}

    async def destroy(self, handle):
        self.live.pop(handle.sandbox_id, None)

    async def list_orphans(self):
        return self.orphans


@pytest.fixture
def settings(tmp_path):
    return dataclasses.replace(load_settings(), state_dir=tmp_path, idle_timeout_s=10, max_lifetime_s=100)


async def test_one_sandbox_per_user_and_tokens_map_back(settings, tmp_path):
    backend = FakeBackend()
    manager = SandboxManager(settings, backend, LocalStateStore(tmp_path))
    first = await manager.ensure("alice")
    assert await manager.ensure("alice") is first
    await manager.ensure("bob")
    assert len(backend.live) == 2
    assert manager.user_for_model_token(first.model_token) == "alice"
    spec = backend.live[first.handle.sandbox_id]
    assert spec.env["DEEPSEEK_API_KEY"] == first.model_token
    assert spec.public_url.endswith("/u/alice/")


async def test_release_saves_then_restores_on_next_start(settings, tmp_path):
    backend = FakeBackend()
    store = LocalStateStore(tmp_path)
    manager = SandboxManager(settings, backend, store)
    record = await manager.ensure("alice")
    await manager.release("alice", "logout")
    assert backend.live == {}
    assert manager.user_for_model_token(record.model_token) is None
    await manager.ensure("alice")
    (spec,) = backend.live.values()
    assert spec.restore == {"home": b"state-of-alice"}


async def test_failed_capture_keeps_the_machine(settings, tmp_path):
    backend = FakeBackend(fail_capture=True)
    manager = SandboxManager(settings, backend, LocalStateStore(tmp_path))
    await manager.ensure("alice")
    await manager.release("alice", "logout")
    assert len(backend.live) == 1
    assert manager.get("alice") is None


async def test_reaper_releases_idle_but_not_connected_users(settings, tmp_path):
    backend = FakeBackend()
    manager = SandboxManager(settings, backend, LocalStateStore(tmp_path))
    idle = await manager.ensure("idle")
    busy = await manager.ensure("busy")
    idle.last_seen -= 60
    busy.last_seen -= 60
    busy.active_websockets = 1
    await manager.reap_once()
    assert manager.get("idle") is None
    assert manager.get("busy") is busy
    busy.started_at -= 1000
    await manager.reap_once()
    assert manager.get("busy") is None


async def test_orphans_are_saved_then_destroyed(settings, tmp_path):
    backend = FakeBackend()
    store = LocalStateStore(tmp_path)
    orphan = SandboxHandle(sandbox_id="old", user_id="carol", upstream_url="")
    backend.live["old"] = None
    backend.orphans = [orphan]
    await SandboxManager(settings, backend, store).recover_orphans()
    assert "old" not in backend.live
    assert await store.load("carol") == {"home": b"state-of-carol"}
