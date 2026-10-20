"""Gateway settings, read once from the environment at startup."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

_GATEWAY_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    # Browser-facing root of this gateway, e.g. http://localhost:8000
    public_url: str
    # Root the sandboxes use to reach this gateway's model proxy.
    sandbox_callback_url: str
    # Derives the key that encrypts users' stored API keys; keep it stable.
    secret_key: str
    # Real DeepSeek key shared by groups that allow it; it never enters a sandbox.
    deepseek_api_key: str
    deepseek_upstream: str
    # Forward a request whose key is not a sandbox token unchanged, so a key the
    # user saved in dsh's own settings still works through DEEPSEEK_BASE_URL.
    llm_allow_passthrough: bool
    backend: str
    docker_image: str
    e2b_template: str
    # Labels this gateway's sandboxes; orphan recovery only touches its own.
    instance_id: str
    state_dir: Path
    db_path: Path
    web_dist: Path
    # Created at startup when no administrator exists yet.
    admin_username: str
    admin_password: str
    # Re-applies admin_password to admin_username on startup (password recovery).
    admin_reset_password: bool
    session_ttl_s: int
    # Seed values of the default group; later edits happen in the admin console.
    idle_timeout_s: int
    max_lifetime_s: int
    mem_limit: str
    cpus: float
    reap_interval_s: int
    start_timeout_s: int
    # Environment added to every sandbox, e.g. an egress proxy.
    sandbox_env: dict[str, str] = field(default_factory=dict)

    @property
    def public_hostname(self) -> str:
        return urlsplit(self.public_url).hostname or "localhost"

    @property
    def secure_cookies(self) -> bool:
        return self.public_url.startswith("https://")


def _sandbox_env(callback_url: str) -> dict[str, str]:
    proxy = os.environ.get("SANDBOX_HTTP_PROXY", "").strip()
    if not proxy:
        return {}
    # The model proxy is the gateway itself and must never go through the egress proxy.
    no_proxy = ",".join(filter(None, [urlsplit(callback_url).hostname, "localhost", "127.0.0.1"]))
    return {
        "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "http_proxy": proxy, "https_proxy": proxy,
        "NO_PROXY": no_proxy, "no_proxy": no_proxy,
    }


def load_settings() -> Settings:
    public_url = os.environ.get("GATEWAY_PUBLIC_URL", "http://localhost:8000").rstrip("/")
    port = urlsplit(public_url).port or 80
    callback = os.environ.get("GATEWAY_SANDBOX_CALLBACK_URL", f"http://host.docker.internal:{port}").rstrip("/")
    return Settings(
        public_url=public_url,
        sandbox_callback_url=callback,
        secret_key=os.environ.get("GATEWAY_SECRET_KEY") or secrets.token_urlsafe(32),
        deepseek_api_key=os.environ.get("DEEPSEEK_API_KEY", ""),
        deepseek_upstream=os.environ.get("DEEPSEEK_UPSTREAM", "https://api.deepseek.com").rstrip("/"),
        llm_allow_passthrough=os.environ.get("LLM_ALLOW_PASSTHROUGH", "1") not in {"0", "false", "no"},
        backend=os.environ.get("SANDBOX_BACKEND", "docker"),
        docker_image=os.environ.get("SANDBOX_DOCKER_IMAGE", "dsh-sandbox:dev"),
        e2b_template=os.environ.get("SANDBOX_E2B_TEMPLATE", ""),
        instance_id=os.environ.get("GATEWAY_INSTANCE_ID", "default"),
        state_dir=Path(os.environ.get("GATEWAY_STATE_DIR", "state")).resolve(),
        db_path=Path(os.environ.get("GATEWAY_DB_PATH", "data/gateway.db")).resolve(),
        web_dist=Path(os.environ.get("GATEWAY_WEB_DIST", str(_GATEWAY_DIR.parent / "web" / "dist"))).resolve(),
        admin_username=os.environ.get("GATEWAY_ADMIN_USERNAME", "admin"),
        admin_password=os.environ.get("GATEWAY_ADMIN_PASSWORD", ""),
        admin_reset_password=os.environ.get("GATEWAY_ADMIN_RESET_PASSWORD", "") in {"1", "true", "yes"},
        session_ttl_s=int(os.environ.get("GATEWAY_SESSION_TTL_S", str(7 * 24 * 3600))),
        idle_timeout_s=int(os.environ.get("SANDBOX_IDLE_TIMEOUT_S", "900")),
        max_lifetime_s=int(os.environ.get("SANDBOX_MAX_LIFETIME_S", "28800")),
        mem_limit=os.environ.get("SANDBOX_MEM_LIMIT", "2g"),
        cpus=float(os.environ.get("SANDBOX_CPUS", "2")),
        reap_interval_s=int(os.environ.get("SANDBOX_REAP_INTERVAL_S", "15")),
        start_timeout_s=int(os.environ.get("SANDBOX_START_TIMEOUT_S", "600")),
        sandbox_env=_sandbox_env(callback),
    )
