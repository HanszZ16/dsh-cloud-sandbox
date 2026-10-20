import dataclasses

import pytest

from dsh_gateway.backends.base import SandboxHandle, SandboxResources
from dsh_gateway.config import load_settings
from dsh_gateway.manager import SandboxManager
from dsh_gateway.policy import SandboxPolicy
from dsh_gateway.store import LocalStateStore

from .conftest import FakeBackend

POLICY = SandboxPolicy(
    resources=SandboxResources(), idle_timeout_s=10, max_lifetime_s=100,
    files={"/etc/dsh-cloud/admin.cordis.yml": b"[]\n"},
)


@pytest.fixture
def settings(tmp_path):
    return dataclasses.replace(load_settings(), state_dir=tmp_path, idle_timeout_s=10, max_lifetime_s=100)


async def test_one_sandbox_per_user_and_tokens_map_back(settings, tmp_path):
    backend = FakeBackend()
    manager = SandboxManager(settings, backend, LocalStateStore(tmp_path))
    first = await manager.ensure("alice", POLICY)
    assert await manager.ensure("alice", POLICY) is first
    await manager.ensure("bob", POLICY)
    assert len(backend.live) == 2
    assert manager.user_for_model_token(first.model_token) == "alice"
    spec = backend.live[first.handle.sandbox_id]
    assert spec.env["DEEPSEEK_API_KEY"] == first.model_token
    assert spec.public_url.endswith("/u/alice/")
    assert spec.files == POLICY.files


async def test_release_saves_then_restores_on_next_start(settings, tmp_path):
    backend = FakeBackend()
    store = LocalStateStore(tmp_path)
    manager = SandboxManager(settings, backend, store)
    record = await manager.ensure("alice", POLICY)
    await manager.release("alice", "logout")
    assert backend.live == {}
    assert manager.user_for_model_token(record.model_token) is None
    await manager.ensure("alice", POLICY)
    (spec,) = backend.live.values()
    assert spec.restore == {"home": b"state-of-alice"}


async def test_failed_capture_keeps_the_machine(settings, tmp_path):
    backend = FakeBackend(fail_capture=True)
    manager = SandboxManager(settings, backend, LocalStateStore(tmp_path))
    await manager.ensure("alice", POLICY)
    await manager.release("alice", "logout")
    assert len(backend.live) == 1
    assert manager.get("alice") is None


async def test_reaper_releases_idle_but_not_connected_users(settings, tmp_path):
    backend = FakeBackend()
    manager = SandboxManager(settings, backend, LocalStateStore(tmp_path))
    idle = await manager.ensure("idle", POLICY)
    busy = await manager.ensure("busy", POLICY)
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


async def test_background_operations_report_status_and_phase(settings, tmp_path):
    import asyncio

    backend = FakeBackend()
    manager = SandboxManager(settings, backend, LocalStateStore(tmp_path))
    manager.start_in_background("alice", POLICY)
    assert manager.status("alice") == "starting"
    while manager.status("alice") == "starting":
        await asyncio.sleep(0)
    assert manager.status("alice") == "running"
    manager.release_in_background("alice", "test")
    assert manager.status("alice") == "releasing"
    while manager.status("alice") == "releasing":
        await asyncio.sleep(0)
    assert manager.status("alice") == "stopped"
    assert backend.steps == ["create", "restore", "boot", "stop", "archive"]
    # Releasing a stopped sandbox ends at once instead of reporting releasing forever.
    manager.release_in_background("alice", "again")
    while manager.status("alice") == "releasing":
        await asyncio.sleep(0)
    assert manager.status("alice") == "stopped"


async def test_restart_saves_then_starts_with_the_new_policy(settings, tmp_path):
    import asyncio

    backend = FakeBackend()
    manager = SandboxManager(settings, backend, LocalStateStore(tmp_path))
    first = await manager.ensure("alice", POLICY)
    newer = dataclasses.replace(POLICY, files={"/etc/dsh-cloud/admin.cordis.yml": b"- id: x\n"})
    manager.restart_in_background("alice", newer, "test")
    while manager.status("alice") != "running" or manager.get("alice") is first:
        await asyncio.sleep(0)
    (spec,) = backend.live.values()
    assert spec.files == newer.files
    assert spec.restore == {"home": b"state-of-alice"}
