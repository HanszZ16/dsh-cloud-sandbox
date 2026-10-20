"""Gateway accounts database: users, groups, plugin catalog, sessions, usage, audit.

SQLite in one file. Every call is short and synchronous behind one lock; the
gateway's load is a handful of writes per login and per model request. User
names are immutable because they key each user's sandbox snapshot directory.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  mem_limit TEXT NOT NULL,
  cpus REAL NOT NULL,
  idle_timeout_s INTEGER NOT NULL,
  max_lifetime_s INTEGER NOT NULL,
  allow_shared_key INTEGER NOT NULL DEFAULT 1,
  daily_request_limit INTEGER NOT NULL DEFAULT 0,
  allowed_models TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  disabled INTEGER NOT NULL DEFAULT 0,
  api_key_enc TEXT,
  created_at REAL NOT NULL,
  last_login_at REAL
);
CREATE TABLE IF NOT EXISTS plugins (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('bundle', 'mcp', 'patch')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_plugins (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  plugin_id INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, plugin_id)
);
CREATE TABLE IF NOT EXISTS user_plugins (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, plugin_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
"""

GROUP_FIELDS = (
    "name", "description", "mem_limit", "cpus", "idle_timeout_s", "max_lifetime_s",
    "allow_shared_key", "daily_request_limit", "allowed_models",
)
USER_FIELDS = ("display_name", "role", "group_id", "disabled")
PLUGIN_FIELDS = ("key", "kind", "name", "description", "config")


@dataclass(frozen=True)
class User:
    id: int
    username: str
    display_name: str
    role: str
    group_id: int
    disabled: bool
    has_api_key: bool
    created_at: float
    last_login_at: float | None

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def today() -> str:
    return time.strftime("%Y-%m-%d", time.localtime())


class Database:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            version = self._conn.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise RuntimeError(f"{path} has schema {version}; this gateway supports up to {SCHEMA_VERSION}")
            self._conn.executescript(_SCHEMA)
            self._conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    def close(self) -> None:
        self._conn.close()

    def _all(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, args).fetchall()

    def _one(self, sql: str, args: tuple = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(sql, args).fetchone()

    def _run(self, sql: str, args: tuple = ()) -> int:
        with self._lock:
            return self._conn.execute(sql, args).lastrowid or 0

    def _many(self, statements: list[tuple[str, tuple]]) -> None:
        with self._lock:
            self._conn.execute("BEGIN")
            try:
                for sql, args in statements:
                    self._conn.execute(sql, args)
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._conn.execute("COMMIT")

    # Groups

    def ensure_default_group(self, values: dict[str, Any]) -> int:
        row = self._one("SELECT id FROM groups ORDER BY id LIMIT 1")
        if row is not None:
            return row["id"]
        return self.create_group({"name": "default", "description": "默认用户组", **values})

    def default_group_id(self) -> int:
        row = self._one("SELECT id FROM groups ORDER BY id LIMIT 1")
        assert row is not None, "ensure_default_group runs at startup"
        return row["id"]

    def list_groups(self) -> list[dict[str, Any]]:
        rows = self._all(
            "SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id) AS user_count "
            "FROM groups g ORDER BY g.id"
        )
        return [self._group_dict(r) for r in rows]

    def get_group(self, group_id: int) -> dict[str, Any] | None:
        row = self._one(
            "SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id) AS user_count "
            "FROM groups g WHERE g.id = ?", (group_id,)
        )
        return None if row is None else self._group_dict(row)

    def _group_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        group = dict(row)
        group["allow_shared_key"] = bool(group["allow_shared_key"])
        group["allowed_models"] = json.loads(group["allowed_models"])
        group["plugin_ids"] = [
            r["plugin_id"] for r in self._all("SELECT plugin_id FROM group_plugins WHERE group_id = ?", (row["id"],))
        ]
        return group

    def create_group(self, values: dict[str, Any]) -> int:
        stored = _group_columns(values)
        columns = ", ".join(stored)
        marks = ", ".join("?" for _ in stored)
        return self._run(f"INSERT INTO groups ({columns}) VALUES ({marks})", tuple(stored.values()))

    def update_group(self, group_id: int, values: dict[str, Any]) -> None:
        stored = _group_columns(values)
        if stored:
            assignments = ", ".join(f"{k} = ?" for k in stored)
            self._run(f"UPDATE groups SET {assignments} WHERE id = ?", (*stored.values(), group_id))

    def delete_group(self, group_id: int) -> None:
        self._run("DELETE FROM groups WHERE id = ?", (group_id,))

    def set_group_plugins(self, group_id: int, plugin_ids: list[int]) -> None:
        self._many(
            [("DELETE FROM group_plugins WHERE group_id = ?", (group_id,))]
            + [("INSERT INTO group_plugins VALUES (?, ?)", (group_id, pid)) for pid in sorted(set(plugin_ids))]
        )

    # Users

    def _user(self, row: sqlite3.Row | None) -> User | None:
        if row is None:
            return None
        return User(
            id=row["id"], username=row["username"], display_name=row["display_name"], role=row["role"],
            group_id=row["group_id"], disabled=bool(row["disabled"]), has_api_key=row["api_key_enc"] is not None,
            created_at=row["created_at"], last_login_at=row["last_login_at"],
        )

    def count_admins(self) -> int:
        return self._one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")["n"]

    def list_users(self) -> list[User]:
        return [self._user(r) for r in self._all("SELECT * FROM users ORDER BY id")]

    def get_user(self, user_id: int) -> User | None:
        return self._user(self._one("SELECT * FROM users WHERE id = ?", (user_id,)))

    def get_user_by_name(self, username: str) -> User | None:
        return self._user(self._one("SELECT * FROM users WHERE username = ?", (username,)))

    def password_hash(self, user_id: int) -> str | None:
        row = self._one("SELECT password_hash FROM users WHERE id = ?", (user_id,))
        return None if row is None else row["password_hash"]

    def create_user(
        self, username: str, password_hash: str, role: str, group_id: int, display_name: str = ""
    ) -> int:
        return self._run(
            "INSERT INTO users (username, display_name, password_hash, role, group_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (username, display_name, password_hash, role, group_id, time.time()),
        )

    def update_user(self, user_id: int, values: dict[str, Any]) -> None:
        stored = {k: (int(v) if k == "disabled" else v) for k, v in values.items() if k in USER_FIELDS}
        if stored:
            assignments = ", ".join(f"{k} = ?" for k in stored)
            self._run(f"UPDATE users SET {assignments} WHERE id = ?", (*stored.values(), user_id))

    def set_password_hash(self, user_id: int, password_hash: str) -> None:
        self._run("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))

    def set_api_key_enc(self, user_id: int, api_key_enc: str | None) -> None:
        self._run("UPDATE users SET api_key_enc = ? WHERE id = ?", (api_key_enc, user_id))

    def api_key_enc(self, user_id: int) -> str | None:
        row = self._one("SELECT api_key_enc FROM users WHERE id = ?", (user_id,))
        return None if row is None else row["api_key_enc"]

    def touch_login(self, user_id: int) -> None:
        self._run("UPDATE users SET last_login_at = ? WHERE id = ?", (time.time(), user_id))

    def delete_user(self, user_id: int) -> None:
        self._run("DELETE FROM users WHERE id = ?", (user_id,))

    def user_plugin_ids(self, user_id: int) -> list[int]:
        return [r["plugin_id"] for r in self._all("SELECT plugin_id FROM user_plugins WHERE user_id = ?", (user_id,))]

    def set_user_plugins(self, user_id: int, plugin_ids: list[int]) -> None:
        self._many(
            [("DELETE FROM user_plugins WHERE user_id = ?", (user_id,))]
            + [("INSERT INTO user_plugins VALUES (?, ?)", (user_id, pid)) for pid in sorted(set(plugin_ids))]
        )

    # Plugin catalog

    def list_plugins(self) -> list[dict[str, Any]]:
        return [self._plugin_dict(r) for r in self._all("SELECT * FROM plugins ORDER BY id")]

    def get_plugin(self, plugin_id: int) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM plugins WHERE id = ?", (plugin_id,))
        return None if row is None else self._plugin_dict(row)

    @staticmethod
    def _plugin_dict(row: sqlite3.Row) -> dict[str, Any]:
        plugin = dict(row)
        plugin["config"] = json.loads(plugin["config"])
        return plugin

    def create_plugin(self, values: dict[str, Any]) -> int:
        stored = _plugin_columns(values)
        columns = ", ".join(stored)
        marks = ", ".join("?" for _ in stored)
        return self._run(f"INSERT INTO plugins ({columns}) VALUES ({marks})", tuple(stored.values()))

    def update_plugin(self, plugin_id: int, values: dict[str, Any]) -> None:
        stored = _plugin_columns(values)
        if stored:
            assignments = ", ".join(f"{k} = ?" for k in stored)
            self._run(f"UPDATE plugins SET {assignments} WHERE id = ?", (*stored.values(), plugin_id))

    def delete_plugin(self, plugin_id: int) -> None:
        self._run("DELETE FROM plugins WHERE id = ?", (plugin_id,))

    def effective_plugins(self, user: User) -> list[dict[str, Any]]:
        """The user's group plugins plus the plugins assigned to the user directly."""
        rows = self._all(
            "SELECT * FROM plugins WHERE id IN ("
            " SELECT plugin_id FROM group_plugins WHERE group_id = ?"
            " UNION SELECT plugin_id FROM user_plugins WHERE user_id = ?) ORDER BY id",
            (user.group_id, user.id),
        )
        return [self._plugin_dict(r) for r in rows]

    # Sessions

    def create_session(self, token_hash: str, user_id: int, ttl_s: int) -> None:
        now = time.time()
        self._run("INSERT INTO sessions VALUES (?, ?, ?, ?)", (token_hash, user_id, now, now + ttl_s))

    def session_user(self, token_hash: str) -> User | None:
        return self._user(self._one(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0",
            (token_hash, time.time()),
        ))

    def delete_session(self, token_hash: str) -> None:
        self._run("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))

    def delete_user_sessions(self, user_id: int) -> None:
        self._run("DELETE FROM sessions WHERE user_id = ?", (user_id,))

    def purge_expired_sessions(self) -> None:
        self._run("DELETE FROM sessions WHERE expires_at <= ?", (time.time(),))

    # Usage

    def count_request(self, user_id: int) -> int:
        """Record one model request for today and return today's total."""
        day = today()
        self._run(
            "INSERT INTO usage (user_id, day, requests) VALUES (?, ?, 1) "
            "ON CONFLICT (user_id, day) DO UPDATE SET requests = requests + 1",
            (user_id, day),
        )
        return self.requests_today(user_id)

    def add_tokens(self, user_id: int, input_tokens: int, output_tokens: int) -> None:
        self._run(
            "INSERT INTO usage (user_id, day, input_tokens, output_tokens) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (user_id, day) DO UPDATE SET "
            "input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens",
            (user_id, today(), input_tokens, output_tokens),
        )

    def requests_today(self, user_id: int) -> int:
        row = self._one("SELECT requests FROM usage WHERE user_id = ? AND day = ?", (user_id, today()))
        return 0 if row is None else row["requests"]

    def usage_today(self) -> dict[int, dict[str, int]]:
        return {
            r["user_id"]: {"requests": r["requests"], "input_tokens": r["input_tokens"], "output_tokens": r["output_tokens"]}
            for r in self._all("SELECT * FROM usage WHERE day = ?", (today(),))
        }

    def usage_by_day(self, days: int) -> list[dict[str, Any]]:
        cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))
        rows = self._all(
            "SELECT day, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens, "
            "SUM(output_tokens) AS output_tokens, COUNT(DISTINCT user_id) AS users "
            "FROM usage WHERE day > ? GROUP BY day ORDER BY day", (cutoff,)
        )
        return [dict(r) for r in rows]

    # Audit

    def audit(self, actor: str, action: str, target: str = "", detail: str = "") -> None:
        self._run(
            "INSERT INTO audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
            (time.time(), actor, action, target, detail),
        )

    def list_audit(self, limit: int) -> list[dict[str, Any]]:
        return [dict(r) for r in self._all("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,))]


def _group_columns(values: dict[str, Any]) -> dict[str, Any]:
    stored: dict[str, Any] = {}
    for key in GROUP_FIELDS:
        if key in values:
            value = values[key]
            if key == "allowed_models":
                value = json.dumps(list(value))
            elif key == "allow_shared_key":
                value = int(bool(value))
            stored[key] = value
    return stored


def _plugin_columns(values: dict[str, Any]) -> dict[str, Any]:
    return {
        k: (json.dumps(values[k]) if k == "config" else values[k]) for k in PLUGIN_FIELDS if k in values
    }
