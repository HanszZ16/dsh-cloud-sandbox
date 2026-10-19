"""Backend-neutral sandbox interface.

A backend owns one isolated machine per user: it starts dsh Web inside it with
the user's restored state, exposes the listener to the gateway, captures the
state on teardown, and destroys the machine. The gateway never touches a
backend SDK directly, so Docker, E2B, or a Kubernetes pool are interchangeable.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

# Archive names a backend produces and accepts. Each is a tar of one directory,
# rooted at that directory's name. "home" is /home/agent: dsh state (DSH_HOME),
# projects, user-level packages, and dotfiles.
STATE_PARTS: tuple[str, ...] = ("home",)


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
    async def start(self, spec: SandboxSpec) -> SandboxHandle:
        """Create the machine, restore state, start dsh Web, and return once it listens."""

    @abstractmethod
    async def launch_url(self, handle: SandboxHandle) -> str:
        """Return the tokenized URL dsh printed at startup (its --public-url plus ?token=)."""

    @abstractmethod
    async def capture(self, handle: SandboxHandle) -> dict[str, bytes]:
        """Stop dsh so its stores are quiescent, then return one archive per STATE_PARTS name."""

    @abstractmethod
    async def destroy(self, handle: SandboxHandle) -> None:
        """Release every resource of the machine. Must succeed on an already-gone machine."""

    async def keepalive(self, handle: SandboxHandle) -> None:
        """Extend a backend-side lifetime limit; called while the user is active."""

    @abstractmethod
    async def list_orphans(self) -> list[SandboxHandle]:
        """Machines this backend created that the gateway no longer tracks (after a restart)."""
