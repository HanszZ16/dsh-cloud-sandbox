"""OpenSandbox backend: one OpenSandbox sandbox per user, created through an OpenSandbox server.

The server (opensandbox-server, Docker runtime in bridge mode) owns the
containers; this backend talks to it and to the execd daemon it injects into
each sandbox, through the `opensandbox` SDK. The gateway itself never touches
Docker.

How the sandbox is laid out:
- dsh listens on port 8080, the one sandbox port the server publishes directly
  on the host; the gateway proxies to it as it does to a Docker container.
- The workspace browser hub listens on loopback port 3081 and is reached
  through execd's port proxy (`/proxy/3081`).
- execd requires a per-sandbox access token (EXECD_ACCESS_TOKEN). Sandboxes
  share a bridge network, so without it one user's sandbox could run commands
  in another's. The token is derived from the gateway secret and a nonce kept
  in the sandbox metadata, so a restarted gateway can still capture orphans;
  keep GATEWAY_SECRET_KEY stable.
- The entry process waits for a start flag, so state is restored before dsh
  starts, and stays alive after dsh exits, so state is captured after dsh has
  closed its stores.
- The admin policy files (/etc/dsh-cloud) are written to a host directory and
  bind-mounted read-only: the image runs as `agent`, which cannot write /etc.
  The server must allow that directory in [storage].allowed_host_paths.
- With home volumes (the default), /home/agent is a per-user named volume
  (an OpenSandbox `pvc` volume) that outlives each sandbox: nothing is
  archived on release. A new volume is filled once, from the user's archive
  when one exists (migration from snapshots), otherwise from /etc/skel, and
  marked so later starts leave it as it is. Without home volumes, home is
  restored from and captured to archives like the other backends.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import re
import secrets
import shlex
import shutil
import time
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlsplit

from .base import Progress, SandboxBackend, SandboxHandle, SandboxSpec, no_progress

log = logging.getLogger("dsh_gateway.backends.opensandbox")

_DSH_PORT = 8080
_HUB_PORT = 3081
_TOKEN_HEADER = "X-EXECD-ACCESS-TOKEN"
_META_USER = "dsh-cloud-user"
_META_INSTANCE = "dsh-cloud-instance"
_META_NONCE = "dsh-cloud-nonce"
# Everything the entry process and this backend exchange inside the sandbox.
_RUN = "/tmp/.dsh-cloud"
_ENTRY = (
    f"mkdir -p {_RUN}; "
    f"until [ -e {_RUN}/start ]; do sleep 0.2; done; "
    f"dsh-sandbox-entrypoint > {_RUN}/web.log 2>&1 & echo $! > {_RUN}/pid; "
    f"wait $!; echo $? > {_RUN}/exit; "
    "exec sleep infinity"
)
# Per archive name: (parent directory, directory name), as tar -C parent name.
_PARTS = {"home": ("/home", "agent")}
_POLICY_DIR = "/etc/dsh-cloud"
# Seconds dsh gets to close its stores after SIGTERM before it is killed, as `docker stop`.
_STOP_GRACE_S = 20
_HOME = "/home/agent"
# Present in a home volume once it has been filled.
_HOME_MARK = f"{_HOME}/.dsh-cloud/home-volume"
_DOCKER_MEMORY = re.compile(r"^(\d+)([kmgt])b?$", re.IGNORECASE)


def memory_quantity(docker_memory: str) -> str:
    """A Docker memory string ("2g": binary units) as an OpenSandbox quantity ("2Gi")."""
    match = _DOCKER_MEMORY.match(docker_memory.strip())
    if match is None:
        # Plain bytes, or already a Kubernetes-style quantity.
        return docker_memory.strip()
    return f"{match.group(1)}{match.group(2).upper()}i"


def volume_name(instance_id: str, home_volume: str) -> str:
    """The Docker volume (OpenSandbox claim) name of a home volume; a DNS label, unique per gateway instance."""
    instance = re.sub(r"[^a-z0-9-]+", "-", instance_id.lower()).strip("-") or "default"
    return f"dsh-home-{instance}-{home_volume}"


def policy_files(files: dict[str, bytes]) -> dict[str, bytes]:
    """`files` relative to /etc/dsh-cloud, the only directory this backend mounts."""
    relative: dict[str, bytes] = {}
    for path, data in files.items():
        if not path.startswith(_POLICY_DIR + "/"):
            raise ValueError(f"the opensandbox backend only places files under {_POLICY_DIR}, not {path}")
        relative[path.removeprefix(_POLICY_DIR + "/")] = data
    return relative


@dataclass
class _Machine:
    sandbox: object
    files_dir: Path


class OpenSandboxBackend(SandboxBackend):
    name = "opensandbox"

    def __init__(
        self, url: str, api_key: str, image: str, files_dir: Path, secret_key: str, start_timeout_s: int,
        instance_id: str, home_volumes: bool,
    ) -> None:
        try:
            from opensandbox import Sandbox, SandboxManager
            from opensandbox.config import ConnectionConfig
        except ImportError as err:
            raise RuntimeError("install the opensandbox extra: uv sync --extra opensandbox") from err
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.netloc:
            raise RuntimeError(f"OPENSANDBOX_URL must be http(s)://host:port, got {url!r}")
        self._sandbox_cls = Sandbox
        self._manager_cls = SandboxManager
        self._config_cls = ConnectionConfig
        self._protocol = parts.scheme
        self._domain = parts.netloc
        self._api_key = api_key or None
        self._image = image
        self._files_dir = files_dir
        self._secret = secret_key.encode()
        self._start_timeout_s = start_timeout_s
        self._instance_id = instance_id
        self._machines: dict[str, _Machine] = {}
        self._manager = None
        self.keeps_home = home_volumes

    def _connection(self, token: str | None = None):
        return self._config_cls(
            domain=self._domain,
            protocol=self._protocol,
            api_key=self._api_key,
            # Archives of a whole home directory pass through single requests.
            request_timeout=timedelta(seconds=self._start_timeout_s),
            headers={_TOKEN_HEADER: token} if token else {},
        )

    def _token(self, nonce: str) -> str:
        return hmac.new(self._secret, f"opensandbox-execd:{nonce}".encode(), hashlib.sha256).hexdigest()

    async def _lifecycle(self):
        if self._manager is None:
            self._manager = await self._manager_cls.create(connection_config=self._connection())
        return self._manager

    async def start(self, spec: SandboxSpec, progress: Progress = no_progress) -> SandboxHandle:
        from opensandbox.models.sandboxes import PVC, Host, Volume

        nonce = secrets.token_hex(8)
        token = self._token(nonce)
        files_dir = self._files_dir / f"{spec.user_id}-{nonce}"
        files = policy_files(spec.files)
        volumes = []
        if files:
            await asyncio.to_thread(_write_tree, files_dir, files)
            volumes.append(Volume(
                name="dsh-cloud-policy", host=Host(path=str(files_dir)), mount_path=_POLICY_DIR, read_only=True,
            ))
        if self.keeps_home:
            if spec.home_volume is None:
                raise ValueError("the opensandbox backend keeps home in a volume; spec.home_volume is required")
            volumes.append(Volume(
                name="home",
                pvc=PVC(
                    claim_name=volume_name(self._instance_id, spec.home_volume),
                    create_if_not_exists=True,
                    delete_on_sandbox_termination=False,
                ),
                mount_path=_HOME,
            ))
        env = dict(spec.env)
        env.update({
            "DSH_PUBLIC_URL": spec.public_url,
            "DSH_TRUSTED_HOST": spec.trusted_host,
            "DSH_PORT": str(_DSH_PORT),
            # execd's port proxy dials loopback.
            "HUB_HOST": "127.0.0.1",
            "EXECD_ACCESS_TOKEN": token,
        })
        progress("create")
        try:
            sbx = await self._sandbox_cls.create(
                spec.image or self._image,
                # The gateway decides when a sandbox ends; the server never expires it.
                timeout=None,
                ready_timeout=timedelta(seconds=self._start_timeout_s),
                env=env,
                metadata={_META_USER: spec.user_id, _META_INSTANCE: self._instance_id, _META_NONCE: nonce},
                resource={
                    "cpu": f"{spec.resources.cpus:g}",
                    "memory": memory_quantity(spec.resources.mem_limit),
                },
                entrypoint=["sh", "-c", _ENTRY],
                volumes=volumes or None,
                connection_config=self._connection(token),
            )
        except BaseException:
            await asyncio.to_thread(shutil.rmtree, files_dir, True)
            raise
        machine = _Machine(sbx, files_dir)
        try:
            progress("restore")
            if self.keeps_home:
                await self._fill_home(sbx, spec)
            else:
                await self._restore(sbx, spec.restore)
            progress("boot")
            await _run(sbx, f"mkdir -p {_RUN} && touch {_RUN}/start")
            await self._wait_listening(sbx)
            dsh = await sbx.get_endpoint(_DSH_PORT)
            hub = await sbx.get_endpoint(_HUB_PORT)
        except BaseException:
            await self._release(sbx.id, machine)
            raise
        self._machines[sbx.id] = machine
        return SandboxHandle(
            sandbox_id=sbx.id,
            user_id=spec.user_id,
            upstream_url=_http(dsh.endpoint),
            browser_url=_http(hub.endpoint),
            browser_headers={**hub.headers, _TOKEN_HEADER: token},
        )

    async def _restore(self, sbx, restore: dict[str, bytes]) -> None:
        for part, data in restore.items():
            parent, _ = _PARTS[part]
            archive = f"/tmp/dsh-cloud-restore-{part}.tar"
            await sbx.files.write_file(archive, data, mode=600)
            await _run(sbx, f"tar -xpf {archive} -C {parent} && rm -f {archive}")

    async def _fill_home(self, sbx, spec: SandboxSpec) -> None:
        """Fill a new home volume once: from the user's archive, else from /etc/skel."""
        if not (await _run(sbx, f"test -w {_HOME} && echo writable || true")).strip():
            raise RuntimeError(f"the home volume of {spec.user_id} is not writable by the sandbox user")
        if (await _run(sbx, f"test -e {_HOME_MARK} && echo filled || true")).strip():
            if spec.restore:
                log.warning(
                    "home volume %s of %s is already filled; its archive is not imported again",
                    spec.home_volume, spec.user_id,
                )
            return
        await self._restore(sbx, spec.restore)
        await _run(sbx, (
            f"cp -rn /etc/skel/. {_HOME}/ && mkdir -p $(dirname {_HOME_MARK}) "
            f"&& echo {shlex.quote(spec.home_volume or '')} > {_HOME_MARK}"
        ))

    async def _wait_listening(self, sbx) -> None:
        deadline = time.monotonic() + self._start_timeout_s
        while time.monotonic() < deadline:
            if await _read_launch_url(sbx):
                return
            code = (await _read_text(sbx, f"{_RUN}/exit")).strip()
            if code:
                tail = (await _read_text(sbx, f"{_RUN}/web.log"))[-2000:]
                raise RuntimeError(f"dsh exited during startup (status {code}):\n{tail}")
            await asyncio.sleep(0.5)
        raise TimeoutError(f"dsh did not start within {self._start_timeout_s}s")

    async def _machine(self, sandbox_id: str) -> _Machine:
        """The tracked machine, or one reconnected from the server's metadata (orphans)."""
        machine = self._machines.get(sandbox_id)
        if machine is not None:
            return machine
        info = await (await self._lifecycle()).get_sandbox_info(sandbox_id)
        metadata = info.metadata or {}
        nonce = metadata[_META_NONCE]
        sbx = await self._sandbox_cls.connect(
            sandbox_id,
            connection_config=self._connection(self._token(nonce)),
            connect_timeout=timedelta(seconds=60),
        )
        machine = _Machine(sbx, self._files_dir / f"{metadata.get(_META_USER, 'unknown')}-{nonce}")
        self._machines[sandbox_id] = machine
        return machine

    async def launch_url(self, handle: SandboxHandle) -> str:
        machine = await self._machine(handle.sandbox_id)
        url = await _read_launch_url(machine.sandbox)
        if not url:
            raise RuntimeError("dsh has not printed its launch URL")
        return url

    async def capture(self, handle: SandboxHandle, progress: Progress = no_progress) -> dict[str, bytes]:
        sbx = (await self._machine(handle.sandbox_id)).sandbox
        progress("stop")
        # SIGTERM to the entrypoint stops dsh and the hub and waits for both; after
        # the grace period they are killed, as `docker stop` would.
        await _run(sbx, (
            f"[ -s {_RUN}/pid ] || exit 0; pid=$(cat {_RUN}/pid); kill -TERM $pid 2>/dev/null; "
            f"i=0; while kill -0 $pid 2>/dev/null && [ $i -lt {_STOP_GRACE_S * 2} ]; do sleep 0.5; i=$((i+1)); done; "
            "if kill -0 $pid 2>/dev/null; then "
            "pkill -KILL -f 'dsh --profile web'; pkill -KILL -f browser-hub/hub.mjs; kill -KILL $pid; sleep 1; fi; "
            "true"
        ))
        if self.keeps_home:
            # The volume outlives the machine; there is nothing to archive.
            return {}
        progress("archive")
        archives: dict[str, bytes] = {}
        for part, (parent, name) in _PARTS.items():
            archive = f"/tmp/dsh-cloud-capture-{part}.tar"
            await _run(sbx, f"tar -cpf {archive} -C {parent} {name}")
            archives[part] = await sbx.files.read_bytes(archive)
        return archives

    async def destroy(self, handle: SandboxHandle) -> None:
        machine = self._machines.get(handle.sandbox_id)
        await self._release(handle.sandbox_id, machine)

    async def _release(self, sandbox_id: str, machine: _Machine | None) -> None:
        from opensandbox.exceptions import SandboxApiException

        try:
            await (await self._lifecycle()).kill_sandbox(sandbox_id)
        except SandboxApiException as err:
            if err.status_code != 404:
                raise
        self._machines.pop(sandbox_id, None)
        if machine is not None:
            await machine.sandbox.close()
            await asyncio.to_thread(shutil.rmtree, machine.files_dir, True)

    async def list_orphans(self) -> list[SandboxHandle]:
        from opensandbox.models.sandboxes import SandboxFilter

        manager = await self._lifecycle()
        found: list[SandboxHandle] = []
        page = 1
        while True:
            result = await manager.list_sandbox_infos(
                SandboxFilter(metadata={_META_INSTANCE: self._instance_id}, page=page, page_size=100),
            )
            for info in result.sandbox_infos:
                metadata = info.metadata or {}
                if info.id in self._machines or info.status.state in {"Terminated", "Stopping"}:
                    continue
                found.append(SandboxHandle(
                    sandbox_id=info.id, user_id=metadata.get(_META_USER, "unknown"), upstream_url="",
                ))
            if not result.pagination or not result.pagination.has_next_page:
                return found
            page += 1


def _write_tree(root: Path, files: dict[str, bytes]) -> None:
    """Write `files` under `root`, world-readable, replacing anything there."""
    shutil.rmtree(root, ignore_errors=True)
    for relative, data in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.parent.chmod(0o755)
        path.write_bytes(data)
        path.chmod(0o644)
    root.chmod(0o755)


def _http(endpoint: str) -> str:
    """An endpoint as returned by the server (host:port[/path]) as an http URL."""
    return endpoint if "://" in endpoint else f"http://{endpoint}"


def _output(lines) -> str:
    return "".join(getattr(line, "text", "") for line in lines or [])


async def _run(sbx, command: str) -> str:
    """Run a shell command as the sandbox user; its stdout, or RuntimeError when it fails."""
    execution = await sbx.commands.run(command)
    if execution.error is not None or (execution.exit_code not in (0, None)):
        detail = _output(execution.logs.stderr) or (execution.error.value if execution.error else "")
        raise RuntimeError(f"sandbox command failed ({execution.exit_code}): {shlex.quote(command)[:200]}\n{detail[-2000:]}")
    return _output(execution.logs.stdout)


async def _read_text(sbx, path: str) -> str:
    """A small text file in the sandbox, or "" when it does not exist yet."""
    return await _run(sbx, f"cat {path} 2>/dev/null || true")


async def _read_launch_url(sbx, path: str = f"{_RUN}/web.log") -> str:
    """Select the last launch line in the sandbox before execd flattens stdout lines."""
    command = r'''awk '$1 == "dsh" && $2 == "web:" && $3 ~ /^https?:\/\// && $3 ~ /[?]token=/ { url = $3 } END { if (url != "") print url }' '''
    return (await _run(sbx, f"{command}{shlex.quote(path)} 2>/dev/null || true")).strip()
