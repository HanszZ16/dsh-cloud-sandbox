"""One sandbox per user: start on demand, release on logout, idle, or age.

Release always captures state before destroying the machine. When capture
fails the machine is left in place (stopped where the backend supports it) so
no user data is discarded; the next gateway start retries it as an orphan.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass, field

from .backends import SandboxBackend, SandboxHandle, SandboxSpec
from .config import Settings
from .policy import SandboxPolicy
from .store import LocalStateStore

log = logging.getLogger("dsh_gateway.manager")


@dataclass
class SandboxRecord:
    handle: SandboxHandle
    model_token: str
    idle_timeout_s: int
    max_lifetime_s: int
    started_at: float = field(default_factory=time.monotonic)
    last_seen: float = field(default_factory=time.monotonic)
    active_websockets: int = 0
    # dsh's auth cookie name, learned from the launch-token exchange.
    auth_cookie: str | None = None

    def touch(self) -> None:
        self.last_seen = time.monotonic()


class SandboxManager:
    def __init__(self, settings: Settings, backend: SandboxBackend, store: LocalStateStore) -> None:
        self._settings = settings
        self._backend = backend
        self._store = store
        self._records: dict[str, SandboxRecord] = {}
        self._token_users: dict[str, str] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._reaper: asyncio.Task[None] | None = None
        # Background starts requested by the portal, and the last start failure per user.
        self._starting: dict[str, asyncio.Task[SandboxRecord]] = {}
        self._start_errors: dict[str, str] = {}

    @property
    def backend(self) -> SandboxBackend:
        return self._backend

    def _lock(self, user_id: str) -> asyncio.Lock:
        return self._locks.setdefault(user_id, asyncio.Lock())

    def get(self, user_id: str) -> SandboxRecord | None:
        return self._records.get(user_id)

    def user_for_model_token(self, token: str) -> str | None:
        return self._token_users.get(token)

    def snapshot(self) -> dict[str, SandboxRecord]:
        return dict(self._records)

    def status(self, user_id: str) -> str:
        if user_id in self._records:
            return "running"
        if self._lock(user_id).locked() or user_id in self._starting:
            return "starting"
        if user_id in self._start_errors:
            return "failed"
        return "stopped"

    def start_error(self, user_id: str) -> str | None:
        return self._start_errors.get(user_id)

    def start_in_background(self, user_id: str, policy: SandboxPolicy) -> None:
        """Start the user's sandbox without waiting; status() reports progress."""
        if user_id in self._records or user_id in self._starting:
            return
        self._start_errors.pop(user_id, None)
        task = asyncio.create_task(self.ensure(user_id, policy))
        self._starting[user_id] = task

        def done(finished: asyncio.Task[SandboxRecord]) -> None:
            self._starting.pop(user_id, None)
            if not finished.cancelled() and finished.exception() is not None:
                log.error("background start for %s failed: %s", user_id, finished.exception())

        task.add_done_callback(done)

    async def ensure(self, user_id: str, policy: SandboxPolicy) -> SandboxRecord:
        record = self._records.get(user_id)
        if record is not None:
            return record
        async with self._lock(user_id):
            record = self._records.get(user_id)
            if record is not None:
                return record
            model_token = "dshgw-" + secrets.token_urlsafe(32)
            callback = self._settings.sandbox_callback_url
            spec = SandboxSpec(
                user_id=user_id,
                public_url=f"{self._settings.public_url}/u/{user_id}/",
                trusted_host=self._settings.public_hostname,
                env={
                    **self._settings.sandbox_env,
                    # A revocable per-sandbox token; the real key stays in the gateway.
                    "DEEPSEEK_API_KEY": model_token,
                    "DEEPSEEK_BASE_URL": f"{callback}/llm/anthropic",
                    "DEEPSEEK_SEARCH_BASE_URL": f"{callback}/llm/anthropic/v1",
                },
                restore=await self._store.load(user_id),
                files=policy.files,
                resources=policy.resources,
            )
            log.info("starting sandbox for %s (restoring %s)", user_id, sorted(spec.restore) or "nothing")
            self._start_errors.pop(user_id, None)
            try:
                handle = await self._backend.start(spec)
            except Exception as err:
                self._start_errors[user_id] = str(err) or type(err).__name__
                raise
            record = SandboxRecord(
                handle=handle, model_token=model_token,
                idle_timeout_s=policy.idle_timeout_s, max_lifetime_s=policy.max_lifetime_s,
            )
            self._records[user_id] = record
            self._token_users[model_token] = user_id
            log.info("sandbox %s ready for %s at %s", handle.sandbox_id[:12], user_id, handle.upstream_url)
            return record

    async def release(self, user_id: str, reason: str) -> None:
        async with self._lock(user_id):
            record = self._records.pop(user_id, None)
            if record is None:
                return
            self._token_users.pop(record.model_token, None)
            log.info("releasing sandbox for %s (%s)", user_id, reason)
            await self._capture_and_destroy(record.handle)

    async def _capture_and_destroy(self, handle: SandboxHandle) -> None:
        try:
            archives = await self._backend.capture(handle)
            await self._store.save(handle.user_id, archives)
        except Exception:
            log.exception(
                "capturing state of sandbox %s for %s failed; keeping the machine for recovery",
                handle.sandbox_id[:12],
                handle.user_id,
            )
            return
        await self._backend.destroy(handle)
        log.info("sandbox %s for %s saved and destroyed", handle.sandbox_id[:12], handle.user_id)

    async def recover_orphans(self) -> None:
        for handle in await self._backend.list_orphans():
            log.warning("recovering orphan sandbox %s for %s", handle.sandbox_id[:12], handle.user_id)
            await self._capture_and_destroy(handle)

    def start_reaper(self) -> None:
        self._reaper = asyncio.create_task(self._reap_forever())

    async def _reap_forever(self) -> None:
        while True:
            await asyncio.sleep(self._settings.reap_interval_s)
            try:
                await self.reap_once()
            except Exception:
                log.exception("reaper pass failed")

    async def reap_once(self) -> None:
        now = time.monotonic()
        for user_id, record in list(self._records.items()):
            age = now - record.started_at
            idle = now - record.last_seen
            if age > record.max_lifetime_s:
                await self.release(user_id, f"max lifetime {record.max_lifetime_s}s reached")
            elif record.active_websockets == 0 and idle > record.idle_timeout_s:
                await self.release(user_id, f"idle for {int(idle)}s")
            else:
                await self._backend.keepalive(record.handle)

    async def shutdown(self) -> None:
        if self._reaper is not None:
            self._reaper.cancel()
        # A start still in flight registers its record when it finishes; wait so
        # the release below includes it instead of leaving an orphan.
        await asyncio.gather(*self._starting.values(), return_exceptions=True)
        await asyncio.gather(
            *(self.release(user_id, "gateway shutdown") for user_id in list(self._records)),
            return_exceptions=True,
        )
