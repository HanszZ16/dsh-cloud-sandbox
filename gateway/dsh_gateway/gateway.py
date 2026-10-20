"""Shared gateway state: settings, accounts database, sandbox manager."""

from __future__ import annotations

import logging
import time
from typing import Any

from starlette.requests import HTTPConnection

from .auth import SecretBox, hash_password, token_hash
from .config import Settings
from .db import Database, User
from .manager import SandboxManager
from .policy import SandboxPolicy, build_policy
from .proxy import GATEWAY_COOKIE

log = logging.getLogger("dsh_gateway")


class Gateway:
    def __init__(self, settings: Settings, db: Database, manager: SandboxManager) -> None:
        self.settings = settings
        self.db = db
        self.manager = manager
        self.secrets = SecretBox(settings.secret_key)

    def bootstrap(self) -> None:
        """Create the default group, and the administrator when none exists or a reset is requested."""
        s = self.settings
        group_id = self.db.ensure_default_group({
            "mem_limit": s.mem_limit, "cpus": s.cpus, "idle_timeout_s": s.idle_timeout_s,
            "max_lifetime_s": s.max_lifetime_s, "allow_shared_key": True,
            "daily_request_limit": 0, "allowed_models": [],
        })
        if self.db.count_admins() > 0 and not (s.admin_reset_password and s.admin_password):
            return
        if not s.admin_password:
            log.warning("no administrator exists; set GATEWAY_ADMIN_PASSWORD and restart to create %r", s.admin_username)
            return
        existing = self.db.get_user_by_name(s.admin_username)
        if existing is None:
            self.db.create_user(s.admin_username, hash_password(s.admin_password), "admin", group_id, "管理员")
        else:
            self.db.update_user(existing.id, {"role": "admin", "disabled": False})
            self.db.set_password_hash(existing.id, hash_password(s.admin_password))
            self.db.delete_user_sessions(existing.id)
        self.db.audit("system", "bootstrap-admin", s.admin_username)
        log.info("set administrator %r from GATEWAY_ADMIN_PASSWORD", s.admin_username)

    def session_user(self, conn: HTTPConnection) -> User | None:
        token = conn.cookies.get(GATEWAY_COOKIE)
        return None if token is None else self.db.session_user(token_hash(token))

    def policy_for(self, user: User) -> SandboxPolicy:
        group = self.db.get_group(user.group_id)
        assert group is not None, "users.group_id references groups"
        return build_policy(user, group, self.db.effective_plugins(user))

    def user_api_key(self, user: User) -> str | None:
        stored = self.db.api_key_enc(user.id)
        return None if stored is None else self.secrets.decrypt(stored)

    def sandbox_info(self, username: str) -> dict[str, Any]:
        record = self.manager.get(username)
        info: dict[str, Any] = {"status": self.manager.status(username), "error": self.manager.start_error(username)}
        op = self.manager.operation(username)
        if op is not None:
            info.update(phase=op.phase, phase_elapsed_s=round(time.monotonic() - op.since, 1))
        if record is not None:
            now = time.monotonic()
            info.update(
                sandbox_id=record.handle.sandbox_id[:12],
                uptime_s=int(now - record.started_at),
                idle_s=int(now - record.last_seen),
                connections=record.active_websockets,
                idle_timeout_s=record.idle_timeout_s,
                max_lifetime_s=record.max_lifetime_s,
            )
        return info
