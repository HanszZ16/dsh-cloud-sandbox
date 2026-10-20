"""Shared test doubles."""

from dsh_gateway.backends.base import ImageInfo, SandboxBackend, SandboxHandle, SandboxSpec


class FakeBackend(SandboxBackend):
    name = "fake"

    def __init__(self, fail_capture: bool = False) -> None:
        self.live: dict[str, SandboxSpec] = {}
        self.fail_capture = fail_capture
        self.orphans: list[SandboxHandle] = []
        self.steps: list[str] = []
        base = {"dsh-cloud.contract": "1", "dsh-cloud.dsh-version": "0.2.1-rc.2", "dsh-cloud.runtime": "node:22-bookworm-slim"}
        # Image reference -> labels; None is the default image.
        self.images: dict[str | None, dict[str, str]] = {None: base}

    async def start(self, spec, progress=lambda step: None):
        for step in ("create", "restore", "boot"):
            progress(step)
            self.steps.append(step)
        sandbox_id = f"sbx-{len(self.live)}-{spec.user_id}"
        self.live[sandbox_id] = spec
        return SandboxHandle(sandbox_id=sandbox_id, user_id=spec.user_id, upstream_url="http://fake")

    async def launch_url(self, handle):
        return "http://fake/?token=t"

    async def capture(self, handle, progress=lambda step: None):
        for step in ("stop", "archive"):
            progress(step)
            self.steps.append(step)
        if self.fail_capture:
            raise RuntimeError("disk unreadable")
        return {"home": f"state-of-{handle.user_id}".encode()}

    async def destroy(self, handle):
        self.live.pop(handle.sandbox_id, None)

    async def list_orphans(self):
        return self.orphans

    async def inspect_image(self, ref):
        if ref not in self.images:
            raise ValueError(f"no such image {ref}")
        return ImageInfo(ref=ref or "default", labels=self.images[ref])
