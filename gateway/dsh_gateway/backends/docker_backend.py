"""Docker sandbox backend: one container per user on the local Docker daemon.

The container publishes dsh's listener on a random loopback port of the
gateway host. State is restored into the created-but-not-started container and
captured from the stopped container, so dsh's SQLite and JSONL stores are
never copied while being written.
"""

from __future__ import annotations

import asyncio
import re
import secrets
import time

import docker
from docker.errors import NotFound
from docker.models.containers import Container

from .base import Progress, SandboxBackend, SandboxHandle, SandboxSpec, files_archive, no_progress

_LABEL = "dsh-cloud"
_LABEL_USER = "dsh-cloud.user"
_LABEL_INSTANCE = "dsh-cloud.instance"
_LAUNCH_LINE = re.compile(r"dsh web: (https?://\S+\?token=\S+)")
# Per archive name: (captured directory, parent it is extracted into).
_PARTS = {"home": ("/home/agent", "/home")}


class DockerBackend(SandboxBackend):
    name = "docker"

    def __init__(self, image: str, start_timeout_s: int, instance_id: str) -> None:
        self._client = docker.from_env()
        self._image = image
        self._start_timeout_s = start_timeout_s
        self._instance_id = instance_id

    async def start(self, spec: SandboxSpec, progress: Progress = no_progress) -> SandboxHandle:
        progress("create")
        container = await asyncio.to_thread(self._create, spec)
        try:
            progress("restore")
            for part, data in spec.restore.items():
                _, parent = _PARTS[part]
                await asyncio.to_thread(container.put_archive, parent, data)
            if spec.files:
                await asyncio.to_thread(container.put_archive, "/", files_archive(spec.files))
            progress("boot")
            await asyncio.to_thread(container.start)
            await self._wait_listening(container)
            await asyncio.to_thread(container.reload)
        except BaseException:
            await asyncio.to_thread(container.remove, force=True)
            raise
        port = container.ports["3080/tcp"][0]["HostPort"]
        return SandboxHandle(
            sandbox_id=container.id,
            user_id=spec.user_id,
            upstream_url=f"http://127.0.0.1:{port}",
        )

    def _create(self, spec: SandboxSpec) -> Container:
        env = dict(spec.env)
        env["DSH_PUBLIC_URL"] = spec.public_url
        env["DSH_TRUSTED_HOST"] = spec.trusted_host
        return self._client.containers.create(
            self._image,
            name=f"dsh-sbx-{spec.user_id}-{secrets.token_hex(3)}",
            labels={_LABEL: "1", _LABEL_USER: spec.user_id, _LABEL_INSTANCE: self._instance_id},
            environment=env,
            ports={"3080/tcp": ("127.0.0.1", None)},
            extra_hosts={"host.docker.internal": "host-gateway"},
            mem_limit=spec.resources.mem_limit,
            nano_cpus=int(spec.resources.cpus * 1e9),
            pids_limit=1024,
            # Reaps the entrypoint's background plugin provisioner.
            init=True,
        )

    async def _wait_listening(self, container: Container) -> None:
        deadline = time.monotonic() + self._start_timeout_s
        while time.monotonic() < deadline:
            logs = await asyncio.to_thread(container.logs)
            if _LAUNCH_LINE.search(logs.decode(errors="replace")):
                return
            await asyncio.to_thread(container.reload)
            if container.status == "exited":
                tail = logs.decode(errors="replace")[-2000:]
                raise RuntimeError(f"dsh exited during startup:\n{tail}")
            await asyncio.sleep(0.5)
        raise TimeoutError(f"dsh did not start within {self._start_timeout_s}s")

    async def launch_url(self, handle: SandboxHandle) -> str:
        container = await asyncio.to_thread(self._client.containers.get, handle.sandbox_id)
        logs = (await asyncio.to_thread(container.logs)).decode(errors="replace")
        matches = _LAUNCH_LINE.findall(logs)
        if not matches:
            raise RuntimeError("dsh has not printed its launch URL")
        return matches[-1]

    async def capture(self, handle: SandboxHandle, progress: Progress = no_progress) -> dict[str, bytes]:
        container = await asyncio.to_thread(self._client.containers.get, handle.sandbox_id)
        progress("stop")
        # SIGTERM lets dsh close its stores before the copy.
        await asyncio.to_thread(container.stop, timeout=20)
        progress("archive")
        archives: dict[str, bytes] = {}
        for part, (path, _) in _PARTS.items():
            stream, _stat = await asyncio.to_thread(container.get_archive, path)
            archives[part] = await asyncio.to_thread(lambda s=stream: b"".join(s))
        return archives

    async def destroy(self, handle: SandboxHandle) -> None:
        try:
            container = await asyncio.to_thread(self._client.containers.get, handle.sandbox_id)
        except NotFound:
            return
        await asyncio.to_thread(container.remove, force=True)

    async def list_orphans(self) -> list[SandboxHandle]:
        containers = await asyncio.to_thread(
            self._client.containers.list, all=True,
            filters={"label": [_LABEL, f"{_LABEL_INSTANCE}={self._instance_id}"]},
        )
        return [
            SandboxHandle(sandbox_id=c.id, user_id=c.labels.get(_LABEL_USER, "unknown"), upstream_url="")
            for c in containers
        ]
