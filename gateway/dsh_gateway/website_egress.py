"""HTTPS egress for browser tasks initiated with an unconfigured public URL."""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import re
import secrets
import socket
from contextlib import asynccontextmanager, suppress
from urllib.parse import urlsplit, urlunsplit

_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")


def public_hostname(value: str) -> bool:
    labels = value.split(".")
    return (len(value) <= 253 and len(labels) >= 2 and all(_LABEL.fullmatch(x) for x in labels)
            and labels[-1] not in {"localhost", "local", "internal", "onion", "home", "lan", "test", "invalid"}
            and any(c.isalpha() for c in labels[-1]))


def public_login_url(value: str) -> tuple[str, str]:
    if len(value) > 2048 or not value or any(ord(c) <= 32 or ord(c) == 127 or c == "\\" for c in value):
        raise ValueError("Use the public HTTPS URL of the website's login page")
    url = urlsplit(value)
    host = url.hostname or ""
    if url.scheme != "https" or not public_hostname(host) or url.netloc.lower() not in {host, f"{host}:443"}:
        raise ValueError("Use a public HTTPS hostname on port 443 without user information")
    return f"https://{host}", urlunsplit(("https", host, url.path or "/", url.query, ""))


async def _resolve_public(host: str) -> list[tuple[int, str]]:
    if not public_hostname(host):
        raise ValueError("unusable hostname")
    addresses = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    targets = []
    for family, _, _, _, sockaddr in addresses:
        raw = sockaddr[0]
        addr = ipaddress.ip_address(raw)
        if isinstance(addr, ipaddress.IPv6Address):
            addr = addr.ipv4_mapped or addr
        if (not addr.is_global or addr.is_multicast or addr.is_reserved
                or getattr(addr, "sixtofour", None) or getattr(addr, "teredo", None)
                or isinstance(addr, ipaddress.IPv6Address) and (addr in ipaddress.ip_network("64:ff9b::/96")
                                                              or addr in ipaddress.ip_network("64:ff9b:1::/48"))):
            raise ValueError("non-public address")
        target = (family, raw)
        if target not in targets:
            targets.append(target)
    return targets


async def _dial(host: str):
    # Pass the numeric address we verified to the socket, without a second
    # hostname lookup that could resolve to a different address.
    for family, ip in await _resolve_public(host):
        try:
            return await asyncio.wait_for(asyncio.open_connection(ip, 443, family=family), 3)
        except (OSError, TimeoutError):
            continue
    raise OSError("no public endpoint available")


@asynccontextmanager
async def public_https_proxy(host: str):
    """A short lived, authenticated CONNECT proxy that never dials private addresses."""
    password = secrets.token_urlsafe(24)
    auth = b"Basic " + base64.b64encode(f"dsh:{password}".encode())
    clients: set[asyncio.Task] = set()

    async def pipe(reader, writer):
        while data := await asyncio.wait_for(reader.read(32768), 35):
            writer.write(data)
            await asyncio.wait_for(writer.drain(), 10)

    async def handle(reader, writer):
        task = asyncio.current_task()
        if len(clients) >= 32:
            writer.close()
            return
        clients.add(task)
        remote = None
        pumps = []
        try:
            async with asyncio.timeout(10):
                lines = (await reader.readuntil(b"\r\n\r\n")).split(b"\r\n")
                request = re.fullmatch(rb"CONNECT ([a-zA-Z0-9.-]+):443 HTTP/1\.[01]", lines[0])
                if request is None or request[1].decode().lower() != host:
                    writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    await writer.drain()
                    return
                presented = [line.split(b":", 1)[1].strip() for line in lines[1:]
                             if line.lower().startswith(b"proxy-authorization:")]
                if len(presented) != 1 or not secrets.compare_digest(presented[0], auth):
                    writer.write(b'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="DSH"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                    await writer.drain()
                    return
                try:
                    source, remote = await _dial(host)
                except (OSError, ValueError):
                    writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    await writer.drain()
                    return
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
            pumps = [asyncio.create_task(pipe(reader, remote)), asyncio.create_task(pipe(source, writer))]
            await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
        except (ValueError, OSError, TimeoutError, asyncio.LimitOverrunError, asyncio.IncompleteReadError):
            pass
        finally:
            for pump in pumps:
                pump.cancel()
            if pumps:
                await asyncio.gather(*pumps, return_exceptions=True)
            for connection in (writer, remote):
                if connection is not None:
                    connection.close()
            clients.discard(task)

    server = await asyncio.start_server(handle, "127.0.0.1", 0, limit=16384)
    try:
        port = server.sockets[0].getsockname()[1]
        yield {"server": f"http://127.0.0.1:{port}", "username": "dsh", "password": password, "bypass": "<-loopback>"}
    finally:
        server.close()
        pending = list(clients)
        for task in pending:
            task.cancel()
        with suppress(asyncio.CancelledError):
            await asyncio.gather(*pending, return_exceptions=True)
        await server.wait_closed()
