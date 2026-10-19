"""Gateway entry: login, per-user sandbox routing, and the model proxy.

Routes:
  GET  /                    sign-in form, or the signed-in user's status page
  POST /login, /logout      logout captures state and releases the sandbox
  *    /u/<user>/...        the user's dsh Web, started on first use
  *    /llm/...             DeepSeek API proxy for sandboxes (per-sandbox token)
"""

from __future__ import annotations

import html
import logging
import re
import secrets
import time
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, Form, Request, WebSocket
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from itsdangerous import BadSignature, URLSafeSerializer
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse

from .backends import create_backend
from .config import Settings, load_settings
from .manager import SandboxManager
from .proxy import GATEWAY_COOKIE, forward_http, forward_websocket
from .store import LocalStateStore

log = logging.getLogger("dsh_gateway")
_USER_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")
_LLM_DROP = {"host", "content-length", "connection", "authorization", "x-api-key", "cookie", "transfer-encoding"}


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    signer = URLSafeSerializer(settings.secret_key, salt="dsh-gateway-login")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
        logging.getLogger("httpx").setLevel(logging.WARNING)
        backend = create_backend(settings)
        manager = SandboxManager(settings, backend, LocalStateStore(settings.state_dir))
        await manager.recover_orphans()
        manager.start_reaper()
        # Sandbox traffic is local or direct; never route it through a host proxy.
        app.state.sandbox_http = httpx.AsyncClient(timeout=None, trust_env=False, follow_redirects=False)
        app.state.llm_http = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=30))
        app.state.manager = manager
        if not settings.deepseek_api_key:
            log.warning("DEEPSEEK_API_KEY is not set: model requests from sandboxes will fail with 503")
        try:
            yield
        finally:
            await manager.shutdown()
            await app.state.sandbox_http.aclose()
            await app.state.llm_http.aclose()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    def current_user(cookies) -> str | None:
        raw = cookies.get(GATEWAY_COOKIE)
        if raw is None:
            return None
        try:
            return signer.loads(raw)
        except BadSignature:
            return None

    def manager_of(request_or_ws) -> SandboxManager:
        return request_or_ws.app.state.manager

    @app.get("/", response_class=HTMLResponse)
    async def index(request: Request) -> HTMLResponse:
        user = current_user(request.cookies)
        if user is None:
            password_field = (
                '<label>密码 <input name="password" type="password" required></label>'
                if settings.login_password
                else ""
            )
            return HTMLResponse(_page("登录", f"""
<form method="post" action="/login">
  <label>用户名 <input name="user" pattern="[a-z0-9][a-z0-9-]{{0,30}}" required autofocus></label>
  {password_field}
  <button>进入我的云电脑</button>
</form>
<p class="hint">用户名：小写字母、数字、连字符。</p>"""))
        record = manager_of(request).get(user)
        if record is None:
            status = "未运行，打开时会自动启动并恢复你上次的数据。"
        else:
            idle = int(time.monotonic() - record.last_seen)
            status = (
                f"运行中（{html.escape(record.handle.sandbox_id[:12])}），"
                f"已运行 {int(time.monotonic() - record.started_at)} 秒，"
                f"空闲 {idle} 秒，连接 {record.active_websockets} 个。"
            )
        return HTMLResponse(_page("我的云电脑", f"""
<p>你好，<b>{html.escape(user)}</b>。沙箱状态：{status}</p>
<p><a class="button" href="/u/{user}/">打开 DeepSeek Harness</a></p>
<form method="post" action="/logout"><button>退出并释放沙箱</button></form>
<p class="hint">退出时保存工作区和会话，然后销毁沙箱；空闲 {settings.idle_timeout_s} 秒也会自动释放。</p>"""))

    @app.post("/login")
    async def login(user: str = Form(...), password: str = Form("")) -> RedirectResponse:
        if not _USER_ID.match(user):
            return RedirectResponse("/", status_code=303)
        if settings.login_password and not secrets.compare_digest(password, settings.login_password):
            return RedirectResponse("/", status_code=303)
        response = RedirectResponse(f"/u/{user}/", status_code=303)
        response.set_cookie(
            GATEWAY_COOKIE, signer.dumps(user), httponly=True, samesite="lax", path="/",
            secure=settings.public_url.startswith("https://"),
        )
        return response

    @app.post("/logout")
    async def logout(request: Request) -> RedirectResponse:
        user = current_user(request.cookies)
        if user is not None:
            await manager_of(request).release(user, "logout")
        response = RedirectResponse("/", status_code=303)
        response.delete_cookie(GATEWAY_COOKIE, path="/")
        return response

    @app.get("/u/{user_id}")
    async def mount_root(user_id: str) -> RedirectResponse:
        return RedirectResponse(f"/u/{user_id}/", status_code=307)

    @app.api_route("/u/{user_id}/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    async def sandbox_http(request: Request, user_id: str, path: str):
        if current_user(request.cookies) != user_id:
            return RedirectResponse("/", status_code=303)
        manager = manager_of(request)
        try:
            record = await manager.ensure(user_id)
        except Exception as err:
            log.exception("starting sandbox for %s failed", user_id)
            return HTMLResponse(_page("启动失败", f"<pre>{html.escape(str(err))}</pre>"), status_code=502)
        record.touch()
        if (
            path == ""
            and request.method == "GET"
            and "token" not in request.query_params
            and (record.auth_cookie is None or record.auth_cookie not in request.cookies)
        ):
            # Exchange dsh's process launch token for its session cookie. The redirect
            # keeps only path and query so the browser stays on the authority it signed
            # in on; dsh's printed URL names GATEWAY_PUBLIC_URL, which may differ.
            return RedirectResponse(
                same_origin_target(await manager.backend.launch_url(record.handle)), status_code=303
            )
        return await forward_http(request, request.app.state.sandbox_http, record, path, f"/u/{user_id}/")

    @app.websocket("/u/{user_id}/{path:path}")
    async def sandbox_ws(websocket: WebSocket, user_id: str, path: str) -> None:
        if current_user(websocket.cookies) != user_id:
            await websocket.close(code=4401)
            return
        record = manager_of(websocket).get(user_id)
        if record is None:
            await websocket.close(code=4404)
            return
        await forward_websocket(websocket, record, path)

    @app.api_route("/llm/{path:path}", methods=["GET", "POST"])
    async def llm_proxy(request: Request, path: str):
        token = request.headers.get("x-api-key") or ""
        bearer = request.headers.get("authorization", "")
        if not token and bearer.lower().startswith("bearer "):
            token = bearer[7:]
        manager = manager_of(request)
        user = manager.user_for_model_token(token)
        if user is None:
            return JSONResponse({"error": {"message": "invalid sandbox token"}}, status_code=401)
        if not settings.deepseek_api_key:
            return JSONResponse(
                {"error": {"message": "gateway has no DEEPSEEK_API_KEY configured"}}, status_code=503
            )
        record = manager.get(user)
        if record is not None:
            # A running agent turn counts as activity even with the browser closed.
            record.touch()
        headers = {k: v for k, v in request.headers.items() if k.lower() not in _LLM_DROP}
        headers["authorization"] = f"Bearer {settings.deepseek_api_key}"
        headers["x-api-key"] = settings.deepseek_api_key
        url = f"{settings.deepseek_upstream}/{path}"
        if request.url.query:
            url += f"?{request.url.query}"
        client: httpx.AsyncClient = request.app.state.llm_http
        upstream = await client.send(
            client.build_request(request.method, url, headers=headers, content=await request.body()),
            stream=True,
        )
        passthrough = {
            k: v for k, v in upstream.headers.items()
            if k.lower() not in {"content-length", "transfer-encoding", "connection", "set-cookie"}
        }
        return StreamingResponse(
            upstream.aiter_raw(), status_code=upstream.status_code, headers=passthrough,
            background=BackgroundTask(upstream.aclose),
        )

    return app



def same_origin_target(url: str) -> str:
    """Path and query of `url`, so a redirect never moves the browser to another authority."""
    parts = urlsplit(url)
    return parts.path + (f"?{parts.query}" if parts.query else "")
def _page(title: str, body: str) -> str:
    return f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{title} · DSH Cloud</title>
<style>
body{{font:15px/1.6 system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 16px;color:#1f2328;background:#fff}}
@media (prefers-color-scheme:dark){{body{{color:#e6edf3;background:#0d1117}} input{{background:#161b22;color:inherit}}}}
h1{{font-size:22px}} label{{display:block;margin:12px 0}} input{{padding:6px 8px;border:1px solid #8b949e;border-radius:6px;width:100%;box-sizing:border-box}}
button,.button{{display:inline-block;margin-top:8px;padding:8px 14px;border-radius:6px;border:0;background:#4d6bfe;color:#fff;text-decoration:none;cursor:pointer;font:inherit}}
.hint{{color:#8b949e;font-size:13px}} pre{{white-space:pre-wrap}}
</style></head><body><h1>{title}</h1>{body}</body></html>"""

