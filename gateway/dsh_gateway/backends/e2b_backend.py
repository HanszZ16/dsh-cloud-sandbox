"""E2B sandbox backend: one E2B microVM per user.

UNVERIFIED: written against the e2b Python SDK's documented AsyncSandbox API
without an E2B key. Validate start, ingress, capture, and destroy before use.

Requirements beyond the Docker backend:
- An E2B template built from ../../sandbox-image (it creates the `agent` user;
  commands here run as root and start dsh as `agent`).
- GATEWAY_SANDBOX_CALLBACK_URL must be reachable from E2B's network, because
  the sandbox calls back into the gateway's model proxy.
"""

from __future__ import annotations

import asyncio
import re
import time

from .base import Progress, SandboxBackend, SandboxHandle, SandboxSpec, files_archive, no_progress

_LAUNCH_LINE = re.compile(r"dsh web: (https?://\S+\?token=\S+)")
_LOG = "/tmp/dsh-web.log"
_PORT = 3080
_PART_DIRS = {"home": ("/home", "agent")}
_METADATA_KEY = "dsh-cloud-user"
_METADATA_INSTANCE = "dsh-cloud-instance"


class E2BBackend(SandboxBackend):
    name = "e2b"

    def __init__(self, template: str, start_timeout_s: int, idle_timeout_s: int, instance_id: str) -> None:
        try:
            from e2b import AsyncSandbox
        except ImportError as err:
            raise RuntimeError("install the e2b extra: uv sync --extra e2b") from err
        if not template:
            raise RuntimeError("SANDBOX_E2B_TEMPLATE is required for the e2b backend")
        self._sandbox_cls = AsyncSandbox
        self._template = template
        self._start_timeout_s = start_timeout_s
        self._instance_id = instance_id
        # E2B kills a sandbox at its own timeout; keepalive() pushes it forward, and
        # this margin outlives the gateway's idle reaper so the gateway decides first.
        self._e2b_timeout_s = idle_timeout_s + 300
        self._sandboxes: dict[str, object] = {}

    async def start(self, spec: SandboxSpec, progress: Progress = no_progress) -> SandboxHandle:
        progress("create")
        sbx = await self._sandbox_cls.create(
            template=spec.image or self._template,
            timeout=self._e2b_timeout_s,
            metadata={_METADATA_KEY: spec.user_id, _METADATA_INSTANCE: self._instance_id},
        )
        try:
            progress("restore")
            for part, data in spec.restore.items():
                archive = f"/tmp/restore-{part}.tar"
                await sbx.files.write(archive, data)
                await sbx.commands.run(f"tar -xpf {archive} -C {_PART_DIRS[part][0]} && rm {archive}", user="root")
            if spec.files:
                # Resource limits come from the template on E2B; spec.resources is not applied.
                await sbx.files.write("/tmp/dsh-cloud-files.tar", files_archive(spec.files))
                await sbx.commands.run("tar -xpf /tmp/dsh-cloud-files.tar -C / && rm /tmp/dsh-cloud-files.tar", user="root")
            host = sbx.get_host(_PORT)
            env = dict(spec.env)
            env["DSH_PUBLIC_URL"] = spec.public_url
            # The gateway rewrites Host to the E2B ingress authority, so trust that.
            env["DSH_TRUSTED_HOST"] = host
            env["DSH_HOME"] = "/home/agent/.dsh"
            progress("boot")
            await sbx.commands.run(
                f"cd /home/agent && nohup runuser -u agent -- dsh-sandbox-entrypoint > {_LOG} 2>&1 &",
                envs=env,
                background=True,
                user="root",
            )
            await self._wait_listening(sbx)
        except BaseException:
            await sbx.kill()
            raise
        self._sandboxes[sbx.sandbox_id] = sbx
        return SandboxHandle(
            sandbox_id=sbx.sandbox_id,
            user_id=spec.user_id,
            upstream_url=f"https://{host}",
            upstream_authority=host,
            browser_url=f"https://{sbx.get_host(3081)}",
        )

    async def _wait_listening(self, sbx) -> None:
        deadline = time.monotonic() + self._start_timeout_s
        while time.monotonic() < deadline:
            result = await sbx.commands.run(f"cat {_LOG} 2>/dev/null || true")
            if _LAUNCH_LINE.search(result.stdout):
                return
            await asyncio.sleep(1)
        raise TimeoutError(f"dsh did not start within {self._start_timeout_s}s")

    async def keepalive(self, handle: SandboxHandle) -> None:
        sbx = self._sandboxes.get(handle.sandbox_id)
        if sbx is not None:
            await sbx.set_timeout(self._e2b_timeout_s)

    async def launch_url(self, handle: SandboxHandle) -> str:
        sbx = self._sandboxes[handle.sandbox_id]
        result = await sbx.commands.run(f"cat {_LOG}")
        matches = _LAUNCH_LINE.findall(result.stdout)
        if not matches:
            raise RuntimeError("dsh has not printed its launch URL")
        return matches[-1]

    async def capture(self, handle: SandboxHandle, progress: Progress = no_progress) -> dict[str, bytes]:
        sbx = self._sandboxes[handle.sandbox_id]
        progress("stop")
        # SIGTERM, then wait for exit, so dsh closes its stores before the copy.
        await sbx.commands.run(
            "pkill -TERM -f 'dsh --profile web' || true; "
            "for i in $(seq 1 40); do pgrep -f 'dsh --profile web' >/dev/null || break; sleep 0.5; done",
            user="root",
        )
        progress("archive")
        archives: dict[str, bytes] = {}
        for part, (parent, name) in _PART_DIRS.items():
            archive = f"/tmp/capture-{part}.tar"
            await sbx.commands.run(f"tar -cpf {archive} -C {parent} {name}", user="root")
            archives[part] = bytes(await sbx.files.read(archive, format="bytes"))
        return archives

    async def destroy(self, handle: SandboxHandle) -> None:
        sbx = self._sandboxes.pop(handle.sandbox_id, None)
        if sbx is not None:
            await sbx.kill()
        else:
            await self._sandbox_cls.kill(handle.sandbox_id)

    async def list_orphans(self) -> list[SandboxHandle]:
        paginator = self._sandbox_cls.list()
        found: list[SandboxHandle] = []
        for info in await paginator.next_items():
            metadata = info.metadata or {}
            user = metadata.get(_METADATA_KEY)
            if (
                user is not None
                and metadata.get(_METADATA_INSTANCE) == self._instance_id
                and info.sandbox_id not in self._sandboxes
            ):
                found.append(SandboxHandle(sandbox_id=info.sandbox_id, user_id=user, upstream_url=""))
        return found
