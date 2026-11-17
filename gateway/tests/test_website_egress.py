import asyncio
import socket

import pytest

from dsh_gateway.website_egress import _dial, public_login_url


@pytest.mark.parametrize("url", [
    "https://localhost", "https://10.10.0.2", "https://[::ffff:127.0.0.1]/",
    "https://attacker.example@portal.example.com", "https://portal.example.com\\@localhost",
    "https://foo.home/login", "https://portal.example.com\n/admin", "http://portal.example.com/",
])
def test_unconfigured_site_requires_a_real_https_hostname(url):
    with pytest.raises(ValueError):
        public_login_url(url)


@pytest.mark.parametrize("private", ["127.0.0.1", "169.254.169.254", "::ffff:10.1.1.1", "64:ff9b::a01:101"])
async def test_proxy_refuses_nonpublic_dns_answers_before_connecting(monkeypatch, private):
    loop = asyncio.get_running_loop()

    async def resolve(*args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("8.8.8.8", 443)),
                (socket.AF_INET6 if ":" in private else socket.AF_INET, socket.SOCK_STREAM, 0, "", (private, 443))]

    async def connect(*args, **kwargs):
        pytest.fail("must reject all addresses when DNS returns a private result")

    monkeypatch.setattr(loop, "getaddrinfo", resolve)
    monkeypatch.setattr(asyncio, "open_connection", connect)
    with pytest.raises(ValueError, match="non-public"):
        await _dial("portal.example.com")


async def test_proxy_connects_to_the_validated_address_not_the_hostname(monkeypatch):
    loop = asyncio.get_running_loop()

    async def resolve(*args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("8.8.8.8", 443))]

    async def connect(address, port, *, family):
        assert (address, port, family) == ("8.8.8.8", 443, socket.AF_INET)
        return ("reader", "writer")

    monkeypatch.setattr(loop, "getaddrinfo", resolve)
    monkeypatch.setattr(asyncio, "open_connection", connect)
    assert await _dial("portal.example.com") == ("reader", "writer")
