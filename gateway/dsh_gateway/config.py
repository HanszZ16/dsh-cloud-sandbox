"""Gateway settings, read once from the environment at startup."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

_GATEWAY_DIR = Path(__file__).resolve().parent.parent
DEMO_LOGIN_HOST = "dsh-signin-fixture.local"


def demo_login_enabled() -> bool:
    return os.environ.get("WEBSITE_LOGIN_LOCAL_DEMO") == "1"


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
    # OCI runtime for Docker sandboxes, e.g. runsc (gVisor); empty is the daemon's default (runc).
    docker_runtime: str
    e2b_template: str
    # OpenSandbox server root (http://host:port) and its API key.
    opensandbox_url: str
    opensandbox_api_key: str
    # Host directory holding each OpenSandbox sandbox's /etc/dsh-cloud, mounted read-only;
    # the server's [storage].allowed_host_paths must include it.
    opensandbox_files_dir: Path
    # Keep each user's home in an OpenSandbox volume instead of archiving it.
    opensandbox_home_volumes: bool
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
    # Knowledge base uploads: largest file, and the most a user's documents may hold.
    kb_max_file_bytes: int = 50 * 1024 * 1024
    kb_quota_bytes: int = 500 * 1024 * 1024
    # Files panel uploads into a workspace: largest file.
    upload_max_file_bytes: int = 200 * 1024 * 1024
    website_login_origin: str = ""
    website_login_sites_file: str = ""
    website_login_vault_key: str = ""
    website_login_mode: str = "gateway"

    @property
    def public_hostname(self) -> str:
        return urlsplit(self.public_url).hostname or "localhost"

    @property
    def secure_cookies(self) -> bool:
        return self.public_url.startswith("https://")


def _sandbox_env(callback_url: str) -> dict[str, str]:
    proxy = os.environ.get("SANDBOX_HTTP_PROXY", "").strip()
    demo = demo_login_enabled()
    if not proxy and not demo:
        return {}
    # The model proxy is the gateway itself and must never go through the egress proxy.
    no_proxy = ",".join(filter(None, [urlsplit(callback_url).hostname, "localhost", "127.0.0.1", DEMO_LOGIN_HOST if demo else ""]))
    env = {"NO_PROXY": no_proxy, "no_proxy": no_proxy}
    if proxy:
        env.update(HTTP_PROXY=proxy, HTTPS_PROXY=proxy, http_proxy=proxy, https_proxy=proxy)
    if demo:
        env["DSH_BROWSER_LOCAL_DEMO"] = "1"
    return env


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
        docker_runtime=os.environ.get("SANDBOX_DOCKER_RUNTIME", "").strip(),
        e2b_template=os.environ.get("SANDBOX_E2B_TEMPLATE", ""),
        opensandbox_url=os.environ.get("OPENSANDBOX_URL", "http://127.0.0.1:8090").rstrip("/"),
        opensandbox_api_key=os.environ.get("OPENSANDBOX_API_KEY", ""),
        opensandbox_files_dir=Path(os.environ.get("OPENSANDBOX_FILES_DIR", "sandbox-files")).resolve(),
        opensandbox_home_volumes=os.environ.get("OPENSANDBOX_HOME_VOLUMES", "1") not in {"0", "false", "no"},
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
        kb_max_file_bytes=int(float(os.environ.get("KB_MAX_FILE_MB", "50")) * 1024 * 1024),
        kb_quota_bytes=int(float(os.environ.get("KB_QUOTA_MB", "500")) * 1024 * 1024),
        upload_max_file_bytes=int(float(os.environ.get("UPLOAD_MAX_MB", "200")) * 1024 * 1024),
        website_login_origin=os.environ.get("WEBSITE_LOGIN_ORIGIN", "").strip(),
        website_login_sites_file=os.environ.get("WEBSITE_LOGIN_SITES_FILE", "").strip(),
        website_login_vault_key=os.environ.get("WEBSITE_LOGIN_VAULT_KEY", ""),
        website_login_mode=os.environ.get("WEBSITE_LOGIN_MODE", "gateway").strip().lower() or "gateway",
    )
