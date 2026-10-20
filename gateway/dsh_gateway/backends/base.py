"""Backend-neutral sandbox interface.

A backend owns one isolated machine per user: it starts dsh Web inside it with
the user's restored state, exposes the listener to the gateway, captures the
state on teardown, and destroys the machine. The gateway never touches a
backend SDK directly, so Docker, E2B, or a Kubernetes pool are interchangeable.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field

# Archive names a backend produces and accepts. Each is a tar of one directory,
# rooted at that directory's name. "home" is /home/agent: dsh state (DSH_HOME),
# projects, user-level packages, and dotfiles.
STATE_PARTS: tuple[str, ...] = ("home",)

# Reports the step a start or capture has reached. Start steps: "create",
# "restore", "boot"; capture steps: "stop", "archive". The portal shows them
# as a progress bar.
Progress = Callable[[str], None]


def no_progress(_step: str) -> None:
    """Default Progress for callers that do not report."""


@dataclass(frozen=True)
class SandboxResources:
    # Docker memory string, e.g. "2g".
    mem_limit: str = "2g"
    cpus: float = 2.0


@dataclass
class SandboxSpec:
    user_id: str
    # dsh --public-url: the browser-facing root of this user's mount.
    public_url: str
    # dsh --trusted-host: the browser-facing authority.
    trusted_host: str
    # Model credentials and endpoints visible inside the sandbox.
    env: dict[str, str]
    # Previously captured archives keyed by STATE_PARTS name.
    restore: dict[str, bytes] = field(default_factory=dict)
    # Absolute path -> content, written root-owned and read-only before dsh
    # starts: the admin policy and overlay under /etc/dsh-cloud.
    files: dict[str, bytes] = field(default_factory=dict)
    resources: SandboxResources = field(default_factory=SandboxResources)


@dataclass
class SandboxHandle:
    sandbox_id: str
    user_id: str
    # Where the gateway sends proxied HTTP, e.g. http://127.0.0.1:49153
    upstream_url: str
    # When set, the gateway rewrites Host and Origin to this authority because the
    # backend's ingress routes by Host; otherwise the browser's Host is preserved.
    upstream_authority: str | None = None


class SandboxBackend(ABC):
    name: str

    @abstractmethod
    async def start(self, spec: SandboxSpec, progress: Progress = no_progress) -> SandboxHandle:
        """Create the machine, restore state, start dsh Web, and return once it listens."""

    @abstractmethod
    async def launch_url(self, handle: SandboxHandle) -> str:
        """Return the tokenized URL dsh printed at startup (its --public-url plus ?token=)."""

    @abstractmethod
    async def capture(self, handle: SandboxHandle, progress: Progress = no_progress) -> dict[str, bytes]:
        """Stop dsh so its stores are quiescent, then return one archive per STATE_PARTS name."""

    @abstractmethod
    async def destroy(self, handle: SandboxHandle) -> None:
        """Release every resource of the machine. Must succeed on an already-gone machine."""

    async def keepalive(self, handle: SandboxHandle) -> None:
        """Extend a backend-side lifetime limit; called while the user is active."""

    @abstractmethod
    async def list_orphans(self) -> list[SandboxHandle]:
        """Machines this gateway instance created that it no longer tracks (after a restart).

        Only machines labelled with this gateway's instance id qualify, so two
        gateways sharing one Docker host or E2B team never reap each other's users.
        """


def files_archive(files: dict[str, bytes]) -> bytes:
    """A tar rooted at / holding `files` as root-owned, world-readable, read-only entries."""
    import io
    import tarfile

    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as tar:
        made: set[str] = set()
        for path, data in sorted(files.items()):
            parts = path.strip("/").split("/")
            for depth in range(1, len(parts)):
                directory = "/".join(parts[:depth])
                if directory not in made:
                    made.add(directory)
                    info = tarfile.TarInfo(directory)
                    info.type, info.mode = tarfile.DIRTYPE, 0o755
                    tar.addfile(info)
            info = tarfile.TarInfo("/".join(parts))
            info.size, info.mode = len(data), 0o644
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()
