"""HTTP and WebSocket forwarding between a user's browser and their sandbox.

Implements the reverse-proxy obligations dsh documents for public deployments:
preserve the browser Host (or rewrite Host and Origin together for ingresses
that route by Host), strip the /u/<user> mount, forward upgrades, and scope
dsh's cookies to the mount. The gateway's own login cookie never reaches a
sandbox.
"""

from __future__ import annotations

import asyncio
import logging
from urllib.parse import urlsplit

import httpx
from fastapi import Request, WebSocket
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed
from starlette.websockets import WebSocketDisconnect

from .manager import SandboxRecord

log = logging.getLogger("dsh_gateway.proxy")

GATEWAY_COOKIE = "dshgw_session"
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
    "trailer", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}
_WS_SKIP = _HOP_BY_HOP | {
    "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions",
    "sec-websocket-protocol", "origin", "cookie",
}


def strip_gateway_cookie(cookie_header: str | None) -> str | None:
    if not cookie_header:
        return None
    kept = [
        part.strip()
        for part in cookie_header.split(";")
        if part.strip() and part.split("=", 1)[0].strip() != GATEWAY_COOKIE
    ]
    return "; ".join(kept) or None


def scope_set_cookie(value: str, mount: str) -> str:
    attrs = [a.strip() for a in value.split(";")]
    scoped = [a for a in attrs if not a.lower().startswith("path=")]
    scoped.append(f"Path={mount}")
    return "; ".join(scoped)


def rewrite_location(location: str, mount: str, upstream_url: str) -> str:
    if location.startswith(upstream_url):
        return mount.rstrip("/") + location[len(upstream_url):]
    if location.startswith("/") and not location.startswith("//"):
        return mount.rstrip("/") + location
    return location


def _upstream_headers(request_headers, record: SandboxRecord, browser_host: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    for name, value in request_headers.items():
        if name.lower() in _HOP_BY_HOP or name.lower() == "cookie":
            continue
        headers[name] = value
    cookie = strip_gateway_cookie(request_headers.get("cookie"))
    if cookie:
        headers["cookie"] = cookie
    authority = record.handle.upstream_authority
    if authority is None:
        headers["host"] = browser_host
    else:
        headers["host"] = authority
        if "origin" in {k.lower() for k in headers}:
            headers = {k: v for k, v in headers.items() if k.lower() != "origin"}
            headers["origin"] = f"https://{authority}"
    return headers


async def forward_http(
    request: Request, client: httpx.AsyncClient, record: SandboxRecord, path: str, mount: str
) -> StreamingResponse:
    handle = record.handle
    url = f"{handle.upstream_url}/{path}"
    if request.url.query:
        url += f"?{request.url.query}"
    headers = _upstream_headers(request.headers, record, request.headers.get("host", ""))
    upstream_request = client.build_request(
        request.method, url, headers=headers, content=request.stream()
    )
    upstream = await client.send(upstream_request, stream=True)

    raw_headers: list[tuple[bytes, bytes]] = []
    for name, value in upstream.headers.multi_items():
        lower = name.lower()
        if lower in _HOP_BY_HOP:
            continue
        if lower == "set-cookie":
            cookie_name = value.split("=", 1)[0].strip()
            if cookie_name.startswith("dsh-auth-"):
                record.auth_cookie = cookie_name
            value = scope_set_cookie(value, mount)
        elif lower == "location":
            value = rewrite_location(value, mount, handle.upstream_url)
        raw_headers.append((lower.encode(), value.encode()))

    response = StreamingResponse(
        upstream.aiter_raw(), status_code=upstream.status_code, background=BackgroundTask(upstream.aclose)
    )
    response.raw_headers = raw_headers
    return response


async def forward_websocket(websocket: WebSocket, record: SandboxRecord, path: str) -> None:
    handle = record.handle
    query = f"?{websocket.url.query}" if websocket.url.query else ""
    extra = [
        (k, v) for k, v in websocket.headers.items() if k.lower() not in _WS_SKIP
    ]
    cookie = strip_gateway_cookie(websocket.headers.get("cookie"))
    if cookie:
        extra.append(("cookie", cookie))
    subprotocols = [
        p.strip() for p in websocket.headers.get("sec-websocket-protocol", "").split(",") if p.strip()
    ]

    upstream_parts = urlsplit(handle.upstream_url)
    if handle.upstream_authority is None:
        # Dial the published port but present the browser's own Host, as the HTTP
        # path does: dsh requires Host and Origin to name the same origin.
        uri = f"ws://{websocket.headers.get('host', '')}/{path}{query}"
        origin = websocket.headers.get("origin")
        dial = {"host": upstream_parts.hostname, "port": upstream_parts.port}
    else:
        uri = f"wss://{handle.upstream_authority}/{path}{query}"
        origin = f"https://{handle.upstream_authority}"
        dial = {}

    try:
        upstream = await ws_connect(
            uri,
            origin=origin,
            additional_headers=extra,
            subprotocols=subprotocols or None,
            max_size=None,
            ping_interval=None,
            compression=None,
            # Sandbox traffic is local or direct; ignore host proxy settings.
            proxy=None,
            **dial,
        )
    except Exception as err:
        log.warning("upstream websocket for %s failed: %s", handle.user_id, err)
        await websocket.close(code=1011)
        return

    await websocket.accept(subprotocol=upstream.subprotocol)
    record.active_websockets += 1
    record.touch()

    async def browser_to_sandbox() -> None:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            record.touch()
            if message.get("bytes") is not None:
                await upstream.send(message["bytes"])
            elif message.get("text") is not None:
                await upstream.send(message["text"])

    async def sandbox_to_browser() -> None:
        async for message in upstream:
            if isinstance(message, bytes):
                await websocket.send_bytes(message)
            else:
                await websocket.send_text(message)

    tasks = [asyncio.create_task(browser_to_sandbox()), asyncio.create_task(sandbox_to_browser())]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            error = task.exception()
            if error is not None and not isinstance(error, (ConnectionClosed, WebSocketDisconnect)):
                log.warning("websocket relay for %s ended with %r", handle.user_id, error)
    finally:
        record.active_websockets -= 1
        record.touch()
        await upstream.close()
        try:
            await websocket.close()
        except (RuntimeError, WebSocketDisconnect):
            # The browser side already closed; nothing is left to close.
            pass
