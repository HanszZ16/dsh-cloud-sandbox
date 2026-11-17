"""An owner-approved login request across the workspace, gateway, and Vault origin."""

from __future__ import annotations

import asyncio
import html
import json
import logging
import re
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.routing import Host

from .auth import DUMMY_HASH, SecretBox, new_session_token, token_hash, verify_password
from .config import Settings
from .gateway import Gateway
from .manager import SandboxRecord
from .website_browser import PublicWebsite, Website, WebsiteBrowserError, sign_in
from .website_egress import public_login_url
from .website_vault_ui import vault_markup

log = logging.getLogger("dsh_gateway")
PLUGIN = "website-login"
COOKIE = "__Host-dshVault"
TTL = 300
SESSION_TTL = 1800
SITE_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
CALL_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
FORM_GRANT = re.compile(r"[A-Za-z0-9_-]{43}")
FRAME_SCRIPT = "/_form-layout.js"
FRAME_JS = """(() => {
  const destination = document.currentScript.dataset.parentOrigin;
  const main = document.querySelector('main');
  const search = document.querySelector('[data-vault-search]');
  if (search) {
    const rows = [...document.querySelectorAll('[data-vault-item]')];
    const empty = document.querySelector('[data-vault-no-results]');
    search.addEventListener('input', () => {
      const query = search.value.trim().toLocaleLowerCase();
      for (const row of rows) row.hidden = !row.querySelector('[data-vault-label]').textContent.toLocaleLowerCase().includes(query);
      empty.hidden = !query || !rows.length || rows.some(row => !row.hidden);
    });
  }
  if (!destination || window.parent === window) return;
  let previous = 0;
  function report() {
    const height = Math.ceil(main.getBoundingClientRect().height);
    if (height !== previous) {
      previous = height;
      window.parent.postMessage({ type: 'dsh-website-login:layout', height }, destination);
    }
  }
  new ResizeObserver(report).observe(main);
  report();
})();"""


def _origin(value: str) -> str:
    parts = urlsplit(value)
    if (parts.scheme != "https" or not parts.hostname or parts.port or parts.path
            or not re.fullmatch(r"[a-z0-9.-]+", parts.hostname)
            or value != f"https://{parts.hostname}"):
        raise ValueError("website login origins must be HTTPS hostnames without ports or paths")
    return value


def _path(value: str) -> str:
    if not re.fullmatch(r"/(?!/)[a-zA-Z0-9/_~.-]*", value) or any(p in {".", ".."} for p in value.split("/")):
        raise ValueError("website login paths must be absolute paths without queries or fragments")
    return value


def _settings(settings: Settings) -> tuple[str, dict[str, Website]]:
    origin = _origin(settings.website_login_origin)
    if not settings.secure_cookies or urlsplit(origin).hostname == urlsplit(settings.public_url).hostname:
        raise ValueError("website login needs HTTPS and a hostname distinct from the dsh gateway")
    if len(settings.website_login_vault_key) < 32:
        raise ValueError("WEBSITE_LOGIN_VAULT_KEY must be a stable random key of at least 32 characters")
    data = json.loads(Path(settings.website_login_sites_file).read_text()) if settings.website_login_sites_file else {}
    sites = {}
    for key, entry in data.items():
        if not SITE_ID.fullmatch(key) or not isinstance(entry["cookies"], list):
            raise ValueError("invalid website login site ID or cookie list")
        site = Website(**{**entry, "cookies": tuple(entry["cookies"])})
        target = _origin(site.origin)
        if urlsplit(target).hostname in {urlsplit(origin).hostname, urlsplit(settings.public_url).hostname} or (
            _path(site.login_path) == _path(site.success_path)
        ):
            raise ValueError("website login requires a separate site with distinct login and success paths")
        if not 1 <= len(set(site.cookies)) == len(site.cookies) <= 16 or not all(
            re.fullmatch(r"[A-Za-z0-9_!#$%&'*+.^`|~\-]{1,128}", name) for name in site.cookies
        ) or not all(isinstance(s, str) and 0 < len(s) <= 512 for s in (
            site.username_selector, site.password_selector, site.submit_selector,
        )):
            raise ValueError("invalid website login selectors or cookie names")
        sites[key] = site
    return origin, sites


def _gateway_origin(public_url: str) -> str:
    parts = urlsplit(public_url)
    host = parts.hostname or ""
    if not re.fullmatch(r"[a-z0-9.-]+", host) or parts.username is not None or parts.password is not None:
        raise ValueError("website login requires a valid DSH public hostname")
    port = f":{parts.port}" if parts.port not in (None, 443) else ""
    return f"https://{host}{port}"


def _embedded(request: Request) -> bool:
    return (request.url.path == "/vault" or request.url.path.startswith("/requests/")) and request.query_params.get("embed") == "1"


@dataclass
class LoginRequest:
    id: str
    call_id: str
    user_id: int
    username: str
    record: SandboxRecord
    website: Website | PublicWebsite
    expires: float
    status: str = "pending"
    failure_reason: str = ""

    @property
    def displayed_status(self) -> str:
        return "working" if self.status == "handing-off" else self.status


class Requests:
    def __init__(self) -> None:
        self.entries: dict[str, LoginRequest] = {}
        self.running = 0

    def sweep(self) -> None:
        now = time.monotonic()
        for key, item in list(self.entries.items()):
            if item.expires + 60 <= now:
                self.entries.pop(key)
            elif item.expires <= now and item.status in {"pending", "working"}:
                item.status = "expired"

    def find(self, record: SandboxRecord, call_id: str) -> LoginRequest | None:
        self.sweep()
        return next((i for i in self.entries.values() if i.record is record and i.call_id == call_id), None)


async def _fields(request: Request, origin: str) -> dict[str, str]:
    if (request.headers.get("origin") != origin
            or request.headers.get("content-type", "").split(";", 1)[0] != "application/x-www-form-urlencoded"):
        raise HTTPException(403)
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 16384:
            raise HTTPException(413)
        body.extend(chunk)
    try:
        values = parse_qs(body.decode("ascii"), keep_blank_values=True, max_num_fields=8, errors="strict")
    except (UnicodeError, ValueError):
        raise HTTPException(400) from None
    if any(len(value) != 1 for value in values.values()):
        raise HTTPException(400)
    return {key: value[0] for key, value in values.items()}


def _page(request: Request, title: str, body: str, status: int = 200) -> HTMLResponse:
    parent = getattr(request.state, "vault_frame_parent", "")
    theme = request.query_params.get("theme", "") if parent else ""
    scheme = f' style="color-scheme:{theme}"' if theme in {"light", "dark"} else ""
    managing = request.url.path in {"/", "/vault"}
    layout = f'<script src="{FRAME_SCRIPT}" data-parent-origin="{html.escape(parent)}"></script>' if parent or managing else ""
    return HTMLResponse(f"""<!doctype html><html lang="zh-CN"{scheme}><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} · DSH</title>
<style>
html{{color-scheme:light dark;font:14px/1.5 system-ui;--text:light-dark(#202633,#e7e9ee);--muted:light-dark(#515b6d,#a9b1be);--line:light-dark(#d8dce4,#464c57);--field:light-dark(#fff,#23262d);--accent:light-dark(#2b5ccc,#9cbaff);color:var(--text)}}
body{{margin:0}} main{{box-sizing:border-box;max-width:30rem;margin:3rem auto;padding:0 1.25rem;display:flow-root}}
.embedded main{{max-width:none;margin:0;padding:12px 14px 15px}}
.eyebrow{{font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.02em;margin:0 0 8px}} .embedded .eyebrow{{display:none}}
h1{{font-size:20px;margin:0 0 6px;letter-spacing:-.02em}} .embedded h1{{font-size:15px}}
p{{color:var(--muted);margin:0 0 12px}} strong{{color:var(--text);overflow-wrap:anywhere}}
label{{display:block;font-weight:500;margin:9px 0}} input:not([type=checkbox]),select{{display:block;width:100%;box-sizing:border-box;margin-top:4px;min-height:34px;border:1px solid var(--line);border-radius:7px;background:var(--field);color:var(--text);padding:6px 9px}}
input[type=checkbox]{{accent-color:var(--accent);vertical-align:-2px;margin:0 5px 0 0}} input,select,button{{font:inherit}}
button{{cursor:pointer;border:1px solid transparent;border-radius:7px;padding:6px 12px;background:#315fd1;color:white;font-weight:600}} button:hover{{filter:brightness(1.1)}}
.actions{{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px}} .secondary{{background:transparent;color:var(--muted);border-color:var(--line)}}
a{{color:var(--accent)}} :focus-visible{{outline:2px solid var(--accent);outline-offset:2px}} hr{{border:0;border-top:1px solid var(--line);margin:12px 0}}
[role=alert]{{color:light-dark(#aa302c,#ffaba4)}} .destination{{font-size:12px;margin-bottom:5px}}
.vault main{{max-width:42rem}} .vault.embedded h1{{font-size:19px}} .vault-toolbar{{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin:15px 0 12px}}
.vault-count{{background:light-dark(#edf1f8,#343a45);padding:5px 10px;border-radius:8px;font-size:12px}} .vault-count strong{{margin-inline-start:4px}}
.vault-search{{flex:0 1 15rem;margin:0;margin-inline-start:auto}} .vault-search input{{border-radius:20px;margin:0;padding:6px 12px}} .vault-add[open]{{flex-basis:100%}}
.vault-add summary{{width:fit-content;list-style:none;cursor:pointer;background:#315fd1;color:#fff;padding:6px 12px;border-radius:8px;font-weight:650}}
.vault-add[open] form,.vault-edit{{padding:10px 13px;background:light-dark(#f5f7fa,#272a31);border-radius:9px;margin-top:8px}}
.vault-list{{overflow:hidden;border:1px solid var(--line);border-radius:12px}} .vault-item+.vault-item{{border-top:1px solid var(--line)}}
.vault-item summary{{padding:10px 13px;cursor:pointer;display:flex;align-items:center;gap:11px;list-style:none}} .vault-item summary:hover{{background:light-dark(#f6f8fc,#282c34)}}
.vault-icon{{display:grid;place-items:center;width:32px;height:32px;flex:0 0 32px;border-radius:9px;color:var(--accent);background:light-dark(#eaf0ff,#303a55)}}
.vault-identity{{display:grid;flex:1;min-width:0}} .vault-identity span{{color:var(--muted);font-size:12px;overflow-wrap:anywhere}}
.vault-chevron{{color:var(--muted);font-size:21px}} .vault-item[open] .vault-chevron{{transform:rotate(90deg)}} .vault-edit{{margin:0 10px 10px}}
.vault-edit form+form{{margin-top:9px}} .vault-footer{{margin-top:14px}} .vault-empty{{padding:18px 14px;text-align:center;margin:0;color:var(--muted)}}
.vault-empty span{{display:block;margin-top:4px;font-size:12px}} .danger{{color:light-dark(#9a3d3a,#ffb0ab)}} .sr-only{{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}}
</style><body class="{'embedded' if parent else ''}{' vault' if managing else ''}">
<main><p class="eyebrow">DSH · 安全登录</p><h1>{title}</h1>{body}</main>{layout}</body></html>""", status_code=status)


def _login_page(request: Request, error: str = "") -> HTMLResponse:
    return _page(request, "验证 DSH 身份", f"""<p>使用你的 DSH 账号确认这次授权。</p>{error}
<form method="post"><input type="hidden" name="action" value="authenticate">
<label>DSH 用户名<input required name="dsh_username" maxlength="31" autocomplete="username"></label>
<label>DSH 密码<input required type="password" name="dsh_password" maxlength="1024" autocomplete="current-password"></label>
<button>验证身份</button></form>""", 401 if error else 200)


def install_website_login(app: FastAPI, settings: Settings) -> None:
    if not settings.website_login_origin:
        return
    origin, sites = _settings(settings)
    embedding_origin = _gateway_origin(settings.public_url)
    vault = SecretBox(settings.website_login_vault_key, b"dsh-website-vault-v1:")
    requests = Requests()
    auth_attempts: dict[str, tuple[float, int]] = {}
    secure = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    # This hostname only serves our own HTML. Never forward a path on it to dsh.
    app.router.routes.insert(0, Host(urlsplit(origin).hostname, app=secure))

    @app.middleware("http")
    async def local_https(request: Request, call_next):
        # Old localhost bookmarks can still sign in, but cannot host the Vault
        # frame. Send human navigations to the configured DSH origin first.
        if (request.method == "GET" and request.headers.get("sec-fetch-mode") == "navigate"
                and request.url.hostname in {"localhost", "127.0.0.1", "::1"}
                and request.url.hostname != urlsplit(embedding_origin).hostname):
            path = request.url.path
            if path in {"/", "/login", "/account", "/admin"} or path.startswith(("/u/", "/admin/")):
                query = f"?{request.url.query}" if request.url.query else ""
                return RedirectResponse(f"{embedding_origin}{path}{query}", 307, headers={"Cache-Control": "no-store"})
        return await call_next(request)

    @secure.middleware("http")
    async def protect(request: Request, call_next):
        if _embedded(request):
            request.state.vault_frame_parent = embedding_origin
        response = await call_next(request)
        parent = getattr(request.state, "vault_frame_parent", "")
        ancestor = parent or "'none'"
        script = f"script-src {origin}{FRAME_SCRIPT}; " if parent or request.url.path in {"/", "/vault"} else ""
        response.headers.update({
            # `no-referrer` also nulls Origin on a native form POST, making
            # the same-origin check reject the Vault's own forms.
            "Cache-Control": "no-store", "Referrer-Policy": "strict-origin",
            "X-Content-Type-Options": "nosniff", "Cross-Origin-Opener-Policy": "same-origin",
            "Content-Security-Policy": f"default-src 'none'; {script}style-src 'unsafe-inline'; form-action 'self'; frame-ancestors {ancestor}; base-uri 'none'",
        })
        return response

    @secure.exception_handler(403)
    async def form_forbidden(request: Request, _: HTTPException) -> HTMLResponse:
        return _page(request, "无法验证表单来源", "<p>请回到 DSH，重新打开安全表单或保险库。</p>", 403)

    @secure.get(FRAME_SCRIPT)
    async def frame_layout() -> Response:
        return Response(FRAME_JS, media_type="text/javascript")

    def gw() -> Gateway:
        return app.state.gw

    def enabled(user) -> bool:
        return bool(user and not user.disabled and any(p["key"] == PLUGIN for p in gw().db.effective_plugins(user)))

    def active(item: LoginRequest) -> bool:
        user = gw().db.get_user_by_name(item.username)
        return (item.expires > time.monotonic() and user is not None and user.id == item.user_id
                and enabled(user) and gw().manager.get(item.username) is item.record)

    def session(request: Request):
        value = request.cookies.get(COOKIE)
        return gw().db.session_user(token_hash("website-login:" + value)) if value else None

    async def verify_dsh_user(request: Request, values: dict[str, str]):
        now = time.monotonic()
        for ip, (until, _) in list(auth_attempts.items()):
            if until <= now:
                auth_attempts.pop(ip)
        ip = request.client.host if request.client else "unknown"
        until, attempts = auth_attempts.get(ip, (now + 60, 0))
        if attempts >= 10 or (ip not in auth_attempts and len(auth_attempts) >= 2048):
            raise HTTPException(429)
        auth_attempts[ip] = (until, attempts + 1)
        user = gw().db.get_user_by_name(values.get("dsh_username", "").strip().lower()[:31])
        stored = gw().db.password_hash(user.id) if user else None
        password = values.get("dsh_password", "")
        if (len(password) > 1024 or not await asyncio.to_thread(verify_password, password, stored or DUMMY_HASH)
                or user is None or user.disabled):
            return None
        return user

    async def authenticate(request: Request, values: dict[str, str]):
        user = await verify_dsh_user(request, values)
        if user is None:
            return _login_page(request, '<p role="alert">DSH 账号或密码无效。</p>')
        token = new_session_token()
        gw().db.create_session(token_hash("website-login:" + token), user.id, SESSION_TTL)
        response = RedirectResponse(request.url.path, status_code=303)
        response.set_cookie(COOKIE, token, max_age=SESSION_TTL, secure=True, httponly=True, samesite="lax", path="/")
        return response

    def grant_hash(item: LoginRequest, grant: str) -> str:
        # The iframe can authenticate even when the browser blocks third-party cookies.
        return token_hash(f"website-login-form:{item.id}:{grant}")

    def form_user(request: Request, values: dict[str, str], item: LoginRequest):
        grant = values.get("grant", "")
        if _embedded(request) and FORM_GRANT.fullmatch(grant):
            return gw().db.session_user(grant_hash(item, grant))
        return session(request)

    def website_form(
        request: Request, item: LoginRequest, grant: str = "", *, embedded: bool = False, notice: str = "", status: int = 200,
    ) -> HTMLResponse:
        token = f'<input type="hidden" name="grant" value="{grant}">' if grant else ""
        options = "".join(f"<option value=\"{c['id']}\">{html.escape(c['username'])}</option>"
                          for c in gw().db.website_credentials(item.user_id) if c["origin"] == item.website.origin)
        saved = f"""<form method="post">{token}<label>已保存账号<select name="credential" required>{options}</select></label>
<button name="action" value="saved">使用此账号并授权</button></form><hr>""" if options else ""
        manage = '' if embedded else ' <a href="/">管理保险库</a>'
        alert = f'<p role="alert">{html.escape(notice)}</p>' if notice else ""
        return _page(request, "登录网站", f"""<p class="destination">目标网站：<strong>{html.escape(item.website.origin)}</strong></p>
<p>授权后，Agent 可以在此网站上以你的身份操作。</p>{alert}{saved}
<form method="post" autocomplete="off">{token}<label>网站账号<input required name="username" maxlength="320" autocomplete="off"></label>
<label>网站密码<input required type="password" name="password" maxlength="1024" autocomplete="off"></label>
<label><input name="save" value="1" type="checkbox"> 登录成功后保存到保险库</label>
<div class="actions"><button name="action" value="submit">登录并授权</button>
<button class="secondary" form="vault-cancel" name="action" value="cancel">拒绝</button>{manage}</div></form>
<form method="post" id="vault-cancel">{token}</form>""", status)

    def from_sandbox(request: Request):
        header = request.headers.get("authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        username = gw().manager.user_for_model_token(token)
        record = gw().manager.get(username) if username else None
        user = gw().db.get_user_by_name(username) if username else None
        if record is None or not record.handle.browser_url or not enabled(user):
            raise HTTPException(403)
        return record, user

    @app.get("/_dsh-cloud/website-login/sites")
    async def configured_sites(request: Request):
        from_sandbox(request)
        return {"supports_login_url": True,
                "sites": [{"id": key, "origin": site.origin, "login_url": site.origin + site.login_path} for key, site in sites.items()]}

    def queue_request(user, record: SandboxRecord, site: Website | PublicWebsite, call_id: str):
        if not CALL_ID.fullmatch(call_id):
            raise HTTPException(404)
        if old := requests.find(record, call_id):
            return {"status": old.displayed_status}
        if len(requests.entries) >= 512 or sum(
            i.record is record and i.displayed_status in {"pending", "working"} for i in requests.entries.values()
        ) >= 3:
            raise HTTPException(429)
        item = LoginRequest(secrets.token_urlsafe(24), call_id, user.id, user.username, record, site, time.monotonic() + TTL)
        requests.entries[item.id] = item
        record.touch()
        gw().db.audit(user.username, "website-login-requested", site.origin)
        return {"status": item.displayed_status}

    @app.post("/_dsh-cloud/website-login/requests/{call_id}/{site_id}")
    async def new_request(request: Request, call_id: str, site_id: str):
        record, user = from_sandbox(request)
        site = sites.get(site_id)
        if site is None:
            raise HTTPException(404)
        return queue_request(user, record, site, call_id)

    @app.post("/_dsh-cloud/website-login/requests/{call_id}")
    async def new_public_request(request: Request, call_id: str):
        record, user = from_sandbox(request)
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > 4096:
                raise HTTPException(413)
            raw.extend(chunk)
        try:
            submitted = json.loads(raw)
            if not isinstance(submitted, dict) or not isinstance(submitted.get("login_url"), str):
                raise ValueError
            site_origin, login_url = public_login_url(submitted["login_url"])
            if urlsplit(site_origin).hostname in {urlsplit(embedding_origin).hostname, urlsplit(origin).hostname}:
                raise ValueError
        except (ValueError, UnicodeError):
            raise HTTPException(400, "invalid-public-https-login-url") from None
        return queue_request(user, record, PublicWebsite(site_origin, login_url), call_id)

    @app.api_route("/_dsh-cloud/website-login/requests/{call_id}", methods=["GET", "DELETE"])
    async def agent_status(request: Request, call_id: str):
        record, _ = from_sandbox(request)
        item = requests.find(record, call_id)
        if item is None:
            raise HTTPException(404)
        if request.method == "DELETE" and item.status in {"pending", "working"}:
            item.status = "cancelled"
        return {"status": item.displayed_status, **({"reason": item.failure_reason} if item.failure_reason else {})}

    @app.get("/u/{username}/_dsh-cloud/website-login/{call_id}")
    async def owner_status(request: Request, username: str, call_id: str):
        user = gw().session_user(request)
        record = gw().manager.get(username)
        if user is None or user.username != username or not enabled(user) or record is None:
            return JSONResponse({"status": "unavailable"}, 404, headers={"Cache-Control": "no-store"})
        item = requests.find(record, call_id)
        if item is None or item.user_id != user.id:
            return JSONResponse({"status": "unavailable"}, 404, headers={"Cache-Control": "no-store"})
        data = {"status": item.displayed_status, "origin": item.website.origin, "dsh_origin": embedding_origin}
        if item.status == "pending":
            data["form_url"] = f"{origin}/requests/{item.id}"
        return JSONResponse(data, headers={"Cache-Control": "no-store"})

    def vault_grant_hash(grant: str) -> str:
        return token_hash("website-login-vault-manage:" + grant)

    @secure.api_route("/vault", methods=["GET", "POST"])
    @secure.api_route("/", methods=["GET", "POST"])
    async def manage(request: Request):
        values = await _fields(request, origin) if request.method == "POST" else {}
        embedded = _embedded(request)
        action = values.get("action")
        grant = values.get("grant", "")
        grant = grant if embedded and FORM_GRANT.fullmatch(grant) else ""
        if action == "authenticate":
            if not embedded:
                return await authenticate(request, values)
            user = await verify_dsh_user(request, values)
            if user is None:
                return _login_page(request, '<p role="alert">DSH 账号或密码无效。</p>')
            grant = new_session_token()
            gw().db.create_session(vault_grant_hash(grant), user.id, SESSION_TTL)
        else:
            user = gw().db.session_user(vault_grant_hash(grant)) if grant else session(request)
        if user is None:
            return _login_page(request)
        if action == "logout":
            if grant:
                gw().db.delete_session(vault_grant_hash(grant))
            elif request.cookies.get(COOKIE):
                gw().db.delete_session(token_hash("website-login:" + request.cookies[COOKIE]))
            response = _login_page(request) if embedded else RedirectResponse("/", 303)
            response.delete_cookie(COOKIE, secure=True, httponly=True, samesite="lax", path="/")
            return response
        editable = enabled(user)
        entries = gw().db.website_credentials(user.id)
        notice = ""
        password = values.get("password", "")
        if action in {"replace", "save"} and not editable:
            raise HTTPException(403)
        # Let the owner remove stored passwords even after the plugin is unassigned.
        if action in {"delete", "replace"}:
            entry = next((row for row in entries if str(row["id"]) == values.get("id")), None)
            if entry is None:
                notice = "找不到该登录记录。"
            elif action == "delete":
                gw().db.delete_website_credential(user.id, entry["id"])
                gw().db.audit(user.username, "website-login-vault-delete", entry["origin"])
                notice = "登录记录已删除。"
                if not embedded:
                    return RedirectResponse("/", 303)
            elif password and len(password) <= 1024 and "\x00" not in password:
                gw().db.replace_website_credential(user.id, entry["id"], vault.encrypt(password))
                gw().db.audit(user.username, "website-login-vault-replace", entry["origin"])
                notice = "密码已更新。"
            else:
                notice = "请输入有效的新密码。"
        if action == "save":
            username = values.get("username", "").strip()
            raw_site = values.get("site", "").strip()
            try:
                if len(raw_site) > 2048 or any(ord(c) <= 32 or c == "\\" for c in raw_site):
                    raise ValueError
                url = urlsplit(raw_site)
                stored_origin = _origin(f"{url.scheme}://{url.netloc.lower()}")
                if not username or len(username) > 320 or not password or len(password) > 1024 or "\x00" in username + password:
                    raise ValueError
            except ValueError:
                notice = "请输入有效的 HTTPS 网站地址、账号和密码。"
            else:
                gw().db.save_website_credential(user.id, stored_origin, username, vault.encrypt(password))
                gw().db.audit(user.username, "website-login-vault-save", stored_origin)
                notice = "登录记录已保存。"
        return _page(request, "密码保险库", vault_markup(gw().db.website_credentials(user.id), grant, editable, notice))

    @secure.api_route("/requests/{request_id}", methods=["GET", "POST"])
    async def login_form(request: Request, request_id: str):
        values = await _fields(request, origin) if request.method == "POST" else {}
        action = values.get("action")
        embedded = _embedded(request)
        if action == "authenticate" and not embedded:
            return await authenticate(request, values)
        requests.sweep()
        item = requests.entries.get(request_id)
        if action == "authenticate":
            user = await verify_dsh_user(request, values)
            if user is None:
                return _login_page(request, '<p role="alert">DSH 账号或密码无效。</p>')
        else:
            user = form_user(request, values, item) if item else session(request)
            if user is None:
                return _login_page(request)
        if item is None or user.id != item.user_id or not active(item):
            return _page(request, "请求已失效", "<p>请回到 DSH 重新发起登录。</p>", 404)
        if item.status != "pending":
            return _page(request, "请求已处理", "<p>请回到 DSH 查看状态。</p>", 409)
        if action == "authenticate":
            grant = new_session_token()
            gw().db.create_session(grant_hash(item, grant), user.id, max(1, int(item.expires - time.monotonic()) + 1))
            return website_form(request, item, grant, embedded=True)
        if request.method == "GET":
            return website_form(request, item, embedded=embedded)

        grant = values.get("grant", "")
        grant_session = grant_hash(item, grant) if embedded and FORM_GRANT.fullmatch(grant) else None
        if action == "cancel":
            item.status = "cancelled"
            if grant_session:
                gw().db.delete_session(grant_session)
            gw().db.audit(user.username, "website-login-cancelled", item.website.origin)
            return _page(request, "已拒绝", "<p>没有向工作区提供登录会话。</p>")
        username, password = values.get("username", ""), values.get("password", "")
        if action == "saved" and re.fullmatch(r"[0-9]{1,18}", values.get("credential", "")):
            saved = gw().db.website_credential(user.id, int(values["credential"]), item.website.origin)
            username = saved["username"] if saved else ""
            password = vault.decrypt(saved["ciphertext"]) if saved else None
        elif action != "submit":
            raise HTTPException(400)
        if not username or not password or len(username) > 320 or len(password) > 1024 or "\x00" in username + password:
            return website_form(request, item, grant if grant_session else "", embedded=embedded,
                                notice="凭据不可用，请重新输入网站账号和密码。", status=400)
        if requests.running >= 4:
            return website_form(request, item, grant if grant_session else "", embedded=embedded,
                                notice="登录服务正忙，请稍后重试。", status=503)
        item.status = "working"
        requests.running += 1
        item.record.touch()
        failure = "browser-login"
        relay_status: int | None = None
        try:
            async with asyncio.timeout(45):
                cookies = await sign_in(item.website, username, password)
                if not active(item) or item.status != "working" or form_user(request, values, item) is None:
                    failure = "request-ended"
                    raise RuntimeError("website login request is no longer active")
                if not cookies:
                    raise WebsiteBrowserError("session-cookie-missing")
                handle = item.record.handle
                failure = "workspace-handoff"
                item.status = "handing-off"
                response = await app.state.sandbox_http.post(
                    handle.browser_url.rstrip("/") + "/_internal/website-session", headers=handle.browser_headers,
                    json={"origin": item.website.origin, "cookies": cookies}, timeout=20,
                )
                if response.status_code != 204:
                    relay_status = response.status_code
                    raise RuntimeError("workspace browser did not accept the session")
            item.status = "signed-in"
        except Exception as error:
            # Browser/transport errors can include arguments or session material.
            failure = error.stage if isinstance(error, WebsiteBrowserError) else failure
            detail = (error.detail if isinstance(error, WebsiteBrowserError) else
                      f"{failure}: HTTP {relay_status}" if relay_status is not None else
                      f"{failure}: {type(error).__name__}")
            if item.status in {"working", "handing-off"}:
                item.status = "failed"
                item.failure_reason = failure
            log.warning("website login failed at %s (%s)", detail, item.website.origin)
            gw().db.audit(user.username, "website-login-failed", item.website.origin, detail)
            message = {
                "browser-start": "登录浏览器没有启动，请稍后重试。",
                "site-unreachable": "登录浏览器连不到目标网站，请检查站点是否可达。",
                "form-unavailable": "未识别到可安全提交的同域密码表单。扫码、跨站登录或分步登录需要其他登录方式。",
                "login-not-confirmed": "网站没有确认登录成功，可能需要额外验证，或账号密码有误。",
                "confirmation-required": "网站需要验证码或其他额外验证，工作区尚未获得登录会话。",
                "session-cookie-missing": "网站没有返回所需的登录会话，请检查站点配置。",
                "request-ended": "授权请求已过期或取消，请重新发起。",
                "workspace-handoff": "网站已登录，但工作区没有收到会话，请重新发起登录。",
            }.get(failure, "无法完成网站登录，请稍后重试。")
            return _page(request, "登录未完成", f"<p>{message}</p>", 502)
        finally:
            requests.running -= 1
            if grant_session:
                gw().db.delete_session(grant_session)
            if item.status in {"working", "handing-off"}:
                item.status = "failed"

        gw().db.audit(user.username, "website-login-authorized", item.website.origin)
        if action == "submit" and values.get("save") == "1":
            try:
                gw().db.save_website_credential(user.id, item.website.origin, username, vault.encrypt(password))
            except Exception:
                return _page(request, "已授权", "<p>网站会话已交给工作区，但密码未能保存。</p>")
            gw().db.audit(user.username, "website-login-vault-save", item.website.origin)
        next_step = "可以收起表单。" if embedded else "可以关闭这个标签页。"
        return _page(request, "已授权", f"<p>网站会话已交给工作区。{next_step}</p>")
