"""Per-user durable state that outlives every sandbox.

Each user owns one directory holding the latest archive per STATE_PARTS name.
Swap this class for object storage (S3/OSS keyed by user id) in production;
the manager only calls load() and save().
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from .backends import STATE_PARTS


class LocalStateStore:
    def __init__(self, root: Path) -> None:
        self._root = root
        self._root.mkdir(parents=True, exist_ok=True)

    def _dir(self, user_id: str) -> Path:
        return self._root / user_id

    def exists(self, user_id: str) -> bool:
        """Whether the user has a saved snapshot, i.e. has used their workspace before."""
        return any((self._dir(user_id) / f"{part}.tar").exists() for part in STATE_PARTS)

    async def load(self, user_id: str) -> dict[str, bytes]:
        return await asyncio.to_thread(self._load, user_id)

    def _load(self, user_id: str) -> dict[str, bytes]:
        found: dict[str, bytes] = {}
        for part in STATE_PARTS:
            path = self._dir(user_id) / f"{part}.tar"
            if path.exists():
                found[part] = path.read_bytes()
        return found

    async def save(self, user_id: str, archives: dict[str, bytes]) -> None:
        await asyncio.to_thread(self._save, user_id, archives)

    def _save(self, user_id: str, archives: dict[str, bytes]) -> None:
        directory = self._dir(user_id)
        directory.mkdir(parents=True, exist_ok=True)
        for part, data in archives.items():
            final = directory / f"{part}.tar"
            partial = directory / f"{part}.tar.partial"
            partial.write_bytes(data)
            # Replace atomically so a crash mid-save keeps the previous snapshot.
            os.replace(partial, final)
