"""Sandbox backends and the factory that selects one from settings."""

from __future__ import annotations

from ..config import Settings
from .base import (
    STATE_PARTS, Progress, SandboxBackend, SandboxHandle, SandboxResources, SandboxSpec, files_archive, no_progress,
)


def create_backend(settings: Settings) -> SandboxBackend:
    if settings.backend == "docker":
        from .docker_backend import DockerBackend

        return DockerBackend(settings.docker_image, settings.start_timeout_s, settings.instance_id)
    if settings.backend == "e2b":
        from .e2b_backend import E2BBackend

        return E2BBackend(
            settings.e2b_template, settings.start_timeout_s, settings.idle_timeout_s, settings.instance_id
        )
    raise RuntimeError(f"unknown SANDBOX_BACKEND {settings.backend!r}; use docker or e2b")


__all__ = [
    "SandboxBackend", "SandboxHandle", "SandboxResources", "SandboxSpec", "STATE_PARTS", "create_backend",
    "files_archive", "Progress", "no_progress",
]
