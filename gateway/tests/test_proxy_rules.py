from dsh_gateway.proxy import (
    GATEWAY_COOKIE, OVERLAY_TAG, inject_overlay, rewrite_location, scope_set_cookie, strip_gateway_cookie,
)


def test_gateway_cookie_never_reaches_sandbox():
    header = f"dsh-auth-abc=v1.x; {GATEWAY_COOKIE}=secret; other=1"
    assert strip_gateway_cookie(header) == "dsh-auth-abc=v1.x; other=1"
    assert strip_gateway_cookie(f"{GATEWAY_COOKIE}=secret") is None


def test_dsh_cookie_is_scoped_to_the_user_mount():
    value = "dsh-auth-abc=v1.x; Max-Age=60; Path=/; HttpOnly; SameSite=Strict"
    scoped = scope_set_cookie(value, "/u/bob/")
    assert "Path=/u/bob/" in scoped
    assert "Path=/;" not in scoped + ";"
    assert scope_set_cookie("a=1", "/u/bob/") == "a=1; Path=/u/bob/"


def test_locations_stay_inside_the_mount():
    upstream = "http://127.0.0.1:32768"
    assert rewrite_location("./", "/u/bob/", upstream) == "./"
    assert rewrite_location("/api/x", "/u/bob/", upstream) == "/u/bob/api/x"
    assert rewrite_location(f"{upstream}/a", "/u/bob/", upstream) == "/u/bob/a"
    assert rewrite_location("https://example.com/", "/u/bob/", upstream) == "https://example.com/"


def test_launch_redirect_keeps_the_signed_in_authority():
    from dsh_gateway.app import same_origin_target

    assert same_origin_target("http://localhost:8000/u/bob/?token=abc") == "/u/bob/?token=abc"
    assert same_origin_target("http://localhost:8000/u/bob/") == "/u/bob/"


def test_overlay_is_injected_once_into_the_head():
    page = inject_overlay(b"<html><head><title>x</title></head><body></body></html>")
    assert page.count(OVERLAY_TAG) == 1
    assert page.index(OVERLAY_TAG) < page.index(b"</head>")
    assert inject_overlay(b"<p>fragment</p>").endswith(OVERLAY_TAG)
