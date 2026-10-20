"""Token accounting for proxied model responses, without altering the stream.

Reads `usage` from Anthropic-format SSE (message_start input, message_delta
cumulative output), OpenAI-format SSE (final chunk), and plain JSON bodies.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

log = logging.getLogger("dsh_gateway.usage")
# A non-streamed body larger than this is passed through without accounting.
_MAX_JSON_BODY = 4 * 1024 * 1024


class UsageMeter:
    def __init__(self, record: Callable[[int, int], None]) -> None:
        self._record = record
        self.input_tokens = 0
        self.output_tokens = 0

    async def observe(self, chunks: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
        pending = b""
        body = bytearray()
        sse = False
        try:
            async for chunk in chunks:
                yield chunk
                if len(body) <= _MAX_JSON_BODY:
                    body.extend(chunk)
                pending += chunk
                *lines, pending = pending.split(b"\n")
                for line in lines:
                    if line.startswith(b"data:"):
                        sse = True
                        self._take(line[5:])
            if pending.startswith(b"data:"):
                self._take(pending[5:])
            elif not sse and len(body) <= _MAX_JSON_BODY:
                self._take(bytes(body))
        finally:
            if self.input_tokens or self.output_tokens:
                try:
                    self._record(self.input_tokens, self.output_tokens)
                except Exception:
                    log.exception("recording token usage failed")

    def _take(self, payload: bytes) -> None:
        if b"usage" not in payload:
            return
        try:
            event = json.loads(payload)
        except ValueError:
            # Not JSON (e.g. "[DONE]" or a partial line): carries no usage.
            return
        if not isinstance(event, dict):
            return
        usage = event.get("usage") or (event.get("message") or {}).get("usage")
        if isinstance(usage, dict):
            self._apply(usage)

    def _apply(self, usage: dict[str, Any]) -> None:
        prompt = usage.get("input_tokens", usage.get("prompt_tokens"))
        cached = (usage.get("cache_read_input_tokens") or 0) + (usage.get("cache_creation_input_tokens") or 0)
        if isinstance(prompt, int) and prompt + cached > 0:
            self.input_tokens = max(self.input_tokens, prompt + cached)
        completion = usage.get("output_tokens", usage.get("completion_tokens"))
        if isinstance(completion, int):
            # Anthropic's message_delta carries the cumulative count.
            self.output_tokens = max(self.output_tokens, completion)
