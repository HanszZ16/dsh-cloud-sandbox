"""Gateway settings, read once from the environment at startup."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Settings:
    # Browser-facing root of this gateway, e.g. http://localhost:8000
    public_url: str
    # Root the sandboxes use to reach this gateway's model proxy.
    sandbox_callback_url: str
    # Signs the gateway's own login cookie.
    secret_key: str
    # Optional shared password; empty means any user name signs in (local PoC only).
    login_password: str
    # Real DeepSeek key; it never enters a sandbox.
    deepseek_api_key: str
    deepseek_upstream: str
    backend: str
    docker_image: str
    e2b_template: str
    state_dir: Path
    idle_timeout_s: int
    max_lifetime_s: int
    reap_interval_s: int
    start_timeout_s: int

    @property
    def public_host(self) -> str:
        return urlsplit(self.public_url).netloc

    @property
    def public_hostname(self) -> str:
        return urlsplit(self.public_url).hostname or "localhost"


def load_settings() -> Settings:
    public_url = os.environ.get("GATEWAY_PUBLIC_URL", "http://localhost:8000").rstrip("/")
    port = urlsplit(public_url).port or 80
    return Settings(
        public_url=public_url,
        sandbox_callback_url=os.environ.get(
            "GATEWAY_SANDBOX_CALLBACK_URL", f"http://host.docker.internal:{port}"
        ).rstrip("/"),
        secret_key=os.environ.get("GATEWAY_SECRET_KEY") or secrets.token_urlsafe(32),
        login_password=os.environ.get("GATEWAY_LOGIN_PASSWORD", ""),
        deepseek_api_key=os.environ.get("DEEPSEEK_API_KEY", ""),
        deepseek_upstream=os.environ.get("DEEPSEEK_UPSTREAM", "https://api.deepseek.com").rstrip("/"),
        backend=os.environ.get("SANDBOX_BACKEND", "docker"),
        docker_image=os.environ.get("SANDBOX_DOCKER_IMAGE", "dsh-sandbox:dev"),
        e2b_template=os.environ.get("SANDBOX_E2B_TEMPLATE", ""),
        state_dir=Path(os.environ.get("GATEWAY_STATE_DIR", "state")).resolve(),
        idle_timeout_s=int(os.environ.get("SANDBOX_IDLE_TIMEOUT_S", "900")),
        max_lifetime_s=int(os.environ.get("SANDBOX_MAX_LIFETIME_S", "28800")),
        reap_interval_s=int(os.environ.get("SANDBOX_REAP_INTERVAL_S", "15")),
        start_timeout_s=int(os.environ.get("SANDBOX_START_TIMEOUT_S", "90")),
    )
