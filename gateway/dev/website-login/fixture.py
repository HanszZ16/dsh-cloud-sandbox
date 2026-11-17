"""A disposable website for testing DSH sign-in using public demo credentials."""

import secrets
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

COOKIE = "__Host-dsh-demo"
SESSION = secrets.token_urlsafe(32)
COOKIE_ATTRS = "Path=/; Secure; HttpOnly; SameSite=Lax"
FORM = """<h1>DSH test website</h1><form method="post" action="/login">
<label>Username <input required id="username" name="username"></label>
<label>Password <input required id="password" name="password" type="password"></label>
<button id="submit" type="submit">Log in</button></form>"""


class Fixture(BaseHTTPRequestHandler):
    def page(self, body, code=200):
        payload = ('<!doctype html><meta charset="utf-8"><title>DSH sign-in test</title>' + body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def redirect(self, target, cookie=None):
        self.send_response(303)
        self.send_header("Location", target)
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def do_GET(self):
        if self.path in {"/", "/login"}:
            self.page(FORM)
        elif self.path == "/dashboard":
            try:
                cookie = SimpleCookie(self.headers.get("Cookie", "")).get(COOKIE)
            except CookieError:
                cookie = None
            if cookie and secrets.compare_digest(cookie.value.encode(), SESSION.encode()):
                self.page('<h1>DSH Secure Login OK</h1><form method="post" action="/logout"><button>Log out</button></form>')
            else:
                self.redirect("/login")
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == "/logout":
            self.redirect("/login", f"{COOKIE}=; {COOKIE_ATTRS}; Max-Age=0")
            return
        if self.path != "/login":
            self.send_error(404)
            return
        raw_length = self.headers.get("Content-Length", "")
        if not raw_length.isdecimal() or len(raw_length) > 4 or int(raw_length) > 4096:
            self.send_error(400)
            return
        try:
            fields = parse_qs(self.rfile.read(int(raw_length)).decode("ascii"), max_num_fields=2)
        except (UnicodeError, ValueError):
            self.send_error(400)
            return
        if fields == {"username": ["demo"], "password": ["dsh-test-only"]}:
            self.redirect("/dashboard", f"{COOKIE}={SESSION}; {COOKIE_ATTRS}")
        else:
            self.page('<p>Incorrect credentials</p>' + FORM, 401)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Fixture).serve_forever()
