"""Shared test doubles."""

from dsh_gateway.backends.base import SandboxBackend, SandboxHandle, SandboxSpec


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
