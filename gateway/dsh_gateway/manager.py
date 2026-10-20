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

from .backends import Progress, SandboxBackend, SandboxHandle, SandboxSpec, no_progress
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
    # The image this sandbox runs; None is the backend default.
    image: str | None = None
    started_at: float = field(default_factory=time.monotonic)
    last_seen: float = field(default_factory=time.monotonic)
    active_websockets: int = 0
    # dsh's auth cookie name, learned from the launch-token exchange.
    auth_cookie: str | None = None

    def touch(self) -> None:
        self.last_seen = time.monotonic()


@dataclass
class Operation:
    """A start or release in progress, with the step it has reached."""

    kind: str  # "starting" or "releasing"
    phase: str
    since: float = field(default_factory=time.monotonic)


class SandboxManager:
    def __init__(self, settings: Settings, backend: SandboxBackend, store: LocalStateStore) -> None:
        self._settings = settings
        self._backend = backend
        self._store = store
        self._records: dict[str, SandboxRecord] = {}
        self._token_users: dict[str, str] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._reaper: asyncio.Task[None] | None = None
        # Starts and releases in flight, the background tasks running them, and
        # the last start failure per user; status() derives from these.
        self._ops: dict[str, Operation] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._start_errors: dict[str, str] = {}

    @property
    def backend(self) -> SandboxBackend:
        return self._backend

    def has_saved_state(self, user_id: str) -> bool:
        return self._store.exists(user_id)

    def _lock(self, user_id: str) -> asyncio.Lock:
        return self._locks.setdefault(user_id, asyncio.Lock())

    def get(self, user_id: str) -> SandboxRecord | None:
        return self._records.get(user_id)

    def user_for_model_token(self, token: str) -> str | None:
        return self._token_users.get(token)

    def snapshot(self) -> dict[str, SandboxRecord]:
        return dict(self._records)

    def active_users(self) -> list[str]:
        """Users with a running sandbox or a start or release in flight."""
        return sorted(set(self._records) | set(self._ops))

    def status(self, user_id: str) -> str:
        """One of starting, releasing, running, failed, stopped."""
        op = self._ops.get(user_id)
        if op is not None:
            return op.kind
        if user_id in self._records:
            return "running"
        if user_id in self._start_errors:
            return "failed"
        return "stopped"

    def operation(self, user_id: str) -> Operation | None:
        return self._ops.get(user_id)

    def start_error(self, user_id: str) -> str | None:
        return self._start_errors.get(user_id)

    def _begin(self, user_id: str, kind: str, phase: str) -> None:
        self._ops[user_id] = Operation(kind, phase)

    def _phase(self, user_id: str, phase: str) -> None:
        op = self._ops.get(user_id)
        if op is not None:
            op.phase, op.since = phase, time.monotonic()

    def _in_background(self, user_id: str, kind: str, work) -> None:
        """Run `work` as the user's one background operation; status() reports it at once."""
        if user_id in self._tasks:
            return
        if user_id not in self._ops:
            self._begin(user_id, kind, "queued")

        async def run() -> None:
            try:
                await work()
            except Exception:
                log.exception("background %s for %s failed", kind, user_id)
            finally:
                self._tasks.pop(user_id, None)
                op = self._ops.get(user_id)
                if op is not None and op.phase == "queued":
                    # Nothing ran (e.g. release of a stopped sandbox).
                    self._ops.pop(user_id, None)

        self._tasks[user_id] = asyncio.create_task(run())

    def start_in_background(self, user_id: str, policy: SandboxPolicy) -> None:
        """Start the user's sandbox without waiting; status() reports progress."""
        if user_id in self._records:
            return
        self._start_errors.pop(user_id, None)

        async def work() -> None:
            await self.ensure(user_id, policy)

        self._in_background(user_id, "starting", work)

    def release_in_background(self, user_id: str, reason: str) -> None:
        """Save and release the user's sandbox without waiting; status() reports progress."""

        async def work() -> None:
            await self.release(user_id, reason)

        self._in_background(user_id, "releasing", work)

    def restart_in_background(self, user_id: str, policy: SandboxPolicy, reason: str) -> None:
        """Save and release, then start again with `policy`."""

        async def work() -> None:
            await self.release(user_id, reason)
            await self.ensure(user_id, policy)

        self._in_background(user_id, "releasing", work)

    async def ensure(self, user_id: str, policy: SandboxPolicy) -> SandboxRecord:
        record = self._records.get(user_id)
        if record is not None:
            return record
        async with self._lock(user_id):
            record = self._records.get(user_id)
            if record is not None:
                return record
            self._begin(user_id, "starting", "prepare")
            try:
                return await self._start(user_id, policy)
            finally:
                self._ops.pop(user_id, None)

    async def _start(self, user_id: str, policy: SandboxPolicy) -> SandboxRecord:
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
            image=policy.image,
        )
        log.info(
            "starting sandbox for %s on %s (restoring %s)",
            user_id, spec.image or "the default image", sorted(spec.restore) or "nothing",
        )
        self._start_errors.pop(user_id, None)
        try:
            handle = await self._backend.start(spec, lambda step: self._phase(user_id, step))
        except Exception as err:
            self._start_errors[user_id] = str(err) or type(err).__name__
            raise
        record = SandboxRecord(
            handle=handle, model_token=model_token,
            idle_timeout_s=policy.idle_timeout_s, max_lifetime_s=policy.max_lifetime_s, image=policy.image,
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
            self._begin(user_id, "releasing", "stop")
            try:
                await self._capture_and_destroy(record.handle, lambda step: self._phase(user_id, step))
            finally:
                self._ops.pop(user_id, None)

    async def _capture_and_destroy(self, handle: SandboxHandle, progress: Progress = no_progress) -> None:
        try:
            archives = await self._backend.capture(handle, progress)
            progress("save")
            await self._store.save(handle.user_id, archives)
        except Exception:
            log.exception(
                "capturing state of sandbox %s for %s failed; keeping the machine for recovery",
                handle.sandbox_id[:12],
                handle.user_id,
            )
            return
        progress("destroy")
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
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)
        await asyncio.gather(
            *(self.release(user_id, "gateway shutdown") for user_id in list(self._records)),
            return_exceptions=True,
        )
