"""Gateway entry: accounts, per-user sandbox routing, the model proxy, and the web UI.

Routes:
  /api/...              account, workspace, and admin JSON API (api.py)
  *    /u/<user>/...    the user's dsh Web, started on first use
  *    /llm/...         DeepSeek API proxy for sandboxes (per-sandbox token)
  GET  /, /login, /account, /admin/...   launch page, sign-in, account settings, admin console (web/dist)
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
from contextlib import asynccontextmanager
from urllib.parse import quote, urlsplit

import httpx
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse

from .api import router as api_router
from .backends import SandboxBackend, create_backend
from .config import Settings, load_settings
from .db import Database
from .gateway import Gateway
from .manager import SandboxManager
from .proxy import forward_http, forward_websocket
from .store import LocalStateStore
from .usage import UsageMeter

log = logging.getLogger("dsh_gateway")
_LLM_DROP = {"host", "content-length", "connection", "authorization", "x-api-key", "cookie", "transfer-encoding"}
# Model calls count toward quotas; model listing and search/fetch tool calls do not.
_METERED_SUFFIXES = ("messages", "chat/completions", "completions")


def create_app(settings: Settings | None = None, backend: SandboxBackend | None = None) -> FastAPI:
    """The gateway app; `backend` replaces the configured one (tests)."""
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
        logging.getLogger("httpx").setLevel(logging.WARNING)
        db = Database(settings.db_path)
        manager = SandboxManager(settings, backend or create_backend(settings), LocalStateStore(settings.state_dir))
        gw = Gateway(settings, db, manager)
        gw.bootstrap()
        await manager.recover_orphans()
        manager.start_reaper()
        app.state.prepull = asyncio.create_task(_prepull_images(gw))
        # Sandbox traffic is local or direct; never route it through a host proxy.
        app.state.sandbox_http = httpx.AsyncClient(timeout=None, trust_env=False, follow_redirects=False)
        app.state.llm_http = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=30))
        app.state.gw = gw
        if not settings.deepseek_api_key:
            log.warning("DEEPSEEK_API_KEY is not set: only users with their own API key can call models")
        if not (settings.web_dist / "index.html").exists():
            log.warning("web UI not built at %s; run `pnpm build` in web/", settings.web_dist)
        try:
            yield
        finally:
            app.state.prepull.cancel()
            await manager.shutdown()
            await app.state.sandbox_http.aclose()
            await app.state.llm_http.aclose()
            db.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(api_router)

    def gw_of(conn) -> Gateway:
        return conn.app.state.gw

    @app.get("/u/{user_id}")
    async def mount_root(user_id: str) -> RedirectResponse:
        return RedirectResponse(f"/u/{user_id}/", status_code=307)

    @app.api_route("/u/{user_id}/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    async def sandbox_http(request: Request, user_id: str, path: str):
        gw = gw_of(request)
        user = gw.session_user(request)
        if user is None:
            return RedirectResponse("/login", status_code=303)
        if user.username != user_id:
            return RedirectResponse(f"/u/{user.username}/", status_code=303)
        record = gw.manager.get(user.username)
        if record is None:
            if _is_navigation(request):
                # The launch page wakes the workspace with progress, then returns here.
                target = f"/u/{user_id}/{path}" + (f"?{request.url.query}" if request.url.query else "")
                return RedirectResponse(f"/?next={quote(target, safe='')}", status_code=303)
            # A page left open on a sleeping workspace must not wake it in the background.
            return JSONResponse({"detail": "workspace is asleep"}, status_code=503)
        record.touch()
        if (
            _is_navigation(request)
            and "token" not in request.query_params
            and (record.auth_cookie is None or record.auth_cookie not in request.cookies)
        ):
            # Exchange dsh's process launch token for its session cookie; a page
            # opened on a restarted workspace carries no cookie for the new dsh. The
            # redirect keeps only path and query so the browser stays on the authority
            # it signed in on; dsh's printed URL names GATEWAY_PUBLIC_URL, which may differ.
            return RedirectResponse(
                same_origin_target(await gw.manager.backend.launch_url(record.handle)), status_code=303
            )
        return await forward_http(request, request.app.state.sandbox_http, record, path, f"/u/{user_id}/")

    @app.websocket("/u/{user_id}/{path:path}")
    async def sandbox_ws(websocket: WebSocket, user_id: str, path: str) -> None:
        gw = gw_of(websocket)
        user = gw.session_user(websocket)
        if user is None or user.username != user_id:
            await websocket.close(code=4401)
            return
        record = gw.manager.get(user_id)
        if record is None:
            await websocket.close(code=4404)
            return
        await forward_websocket(websocket, record, path)

    @app.api_route("/llm/{path:path}", methods=["GET", "POST"])
    async def llm_proxy(request: Request, path: str):
        gw = gw_of(request)
        token = request.headers.get("x-api-key") or ""
        bearer = request.headers.get("authorization", "")
        if not token and bearer.lower().startswith("bearer "):
            token = bearer[7:]
        body = await request.body()
        username = gw.manager.user_for_model_token(token)
        if username is None:
            if settings.llm_allow_passthrough and token and not token.startswith("dshgw-"):
                # A key the user saved in dsh's own settings: forward it unchanged, unmetered.
                return await _forward_llm(request, path, token, body, meter=None)
            return _llm_error(401, "invalid sandbox token")
        user = gw.db.get_user_by_name(username)
        if user is None or user.disabled:
            return _llm_error(403, "account is disabled")
        group = gw.db.get_group(user.group_id) or {}
        key = gw.user_api_key(user)
        if key is None:
            if not group.get("allow_shared_key"):
                return _llm_error(403, "no API key: set your DeepSeek API key in account settings (avatar menu, bottom right)")
            if not settings.deepseek_api_key:
                return _llm_error(503, "no shared API key is configured; set your own key in account settings (avatar menu, bottom right)")
            key = settings.deepseek_api_key
        meter = None
        if request.method == "POST" and path.rstrip("/").endswith(_METERED_SUFFIXES):
            model = _model_of(body)
            allowed = group.get("allowed_models") or []
            if allowed and model not in allowed:
                return _llm_error(403, f"model {model!r} is not allowed for your group; allowed: {', '.join(allowed)}")
            limit = group.get("daily_request_limit") or 0
            if limit and gw.db.requests_today(user.id) >= limit:
                return _llm_error(429, f"daily request limit {limit} reached")
            gw.db.count_request(user.id)
            meter = UsageMeter(lambda i, o: gw.db.add_tokens(user.id, i, o))
        record = gw.manager.get(username)
        if record is not None:
            # A running agent turn counts as activity even with the browser closed.
            record.touch()
        return await _forward_llm(request, path, key, body, meter)

    async def _forward_llm(request: Request, path: str, key: str, body: bytes, meter: UsageMeter | None):
        headers = {k: v for k, v in request.headers.items() if k.lower() not in _LLM_DROP}
        headers["authorization"] = f"Bearer {key}"
        headers["x-api-key"] = key
        url = f"{settings.deepseek_upstream}/{path}"
        if request.url.query:
            url += f"?{request.url.query}"
        client: httpx.AsyncClient = request.app.state.llm_http
        upstream = await client.send(client.build_request(request.method, url, headers=headers, content=body), stream=True)
        passthrough = {
            k: v for k, v in upstream.headers.items()
            if k.lower() not in {"content-length", "transfer-encoding", "connection", "set-cookie", "content-encoding"}
        }
        chunks = upstream.aiter_bytes() if meter is None else meter.observe(upstream.aiter_bytes())
        return StreamingResponse(
            chunks, status_code=upstream.status_code, headers=passthrough, background=BackgroundTask(upstream.aclose)
        )

    # Web UI: hashed build assets plus the single-page app for every other UI route.
    assets = settings.web_dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path.startswith(("api/", "u/", "llm/")):
            return JSONResponse({"detail": "not found"}, status_code=404)
        candidate = (settings.web_dist / path).resolve()
        if path and candidate.is_file() and settings.web_dist in candidate.parents:
            return FileResponse(candidate)
        index = settings.web_dist / "index.html"
        if not index.exists():
            return HTMLResponse(_error_page("页面尚未构建", "在 web/ 目录运行 pnpm install && pnpm build"), status_code=503)
        return FileResponse(index, headers={"cache-control": "no-cache"})

    return app


async def _prepull_images(gw: Gateway) -> None:
    """Fetch every registered image in the background so a user's first start does not wait for a pull."""
    for image in gw.db.list_images():
        try:
            await gw.manager.backend.inspect_image(image["ref"])
        except Exception as err:
            log.warning("image %s is not available: %s", image["ref"], err)


def same_origin_target(url: str) -> str:
    """Path and query of `url`, so a redirect never moves the browser to another authority."""
    parts = urlsplit(url)
    return parts.path + (f"?{parts.query}" if parts.query else "")


def _is_navigation(request: Request) -> bool:
    """A top-level page load, as opposed to a script's fetch."""
    if request.method != "GET":
        return False
    mode = request.headers.get("sec-fetch-mode")
    if mode is not None:
        return mode == "navigate"
    return "text/html" in request.headers.get("accept", "")


def _model_of(body: bytes) -> str | None:
    try:
        value = json.loads(body).get("model")
    except (ValueError, AttributeError):
        # Not a JSON object: the upstream rejects it; there is no model to check.
        return None
    return value if isinstance(value, str) else None


def _llm_error(status: int, message: str) -> JSONResponse:
    # Anthropic error envelope, which dsh's provider surfaces to the user verbatim.
    return JSONResponse(
        {"type": "error", "error": {"type": "permission_error" if status == 403 else "api_error", "message": message}},
        status_code=status,
    )


def _error_page(title: str, detail: str) -> str:
    return f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{html.escape(title)}</title>
<style>body{{font:14px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;max-width:640px;margin:12vh auto;padding:0 16px;color:#0f1115;background:#fff}}
@media (prefers-color-scheme:dark){{body{{color:#f2f3f5;background:#16171a}}}}a{{color:#4d6bfe}}pre{{white-space:pre-wrap;opacity:.8}}</style></head>
<body><h2>{html.escape(title)}</h2><pre>{html.escape(detail)}</pre><p><a href="/">返回</a></p></body></html>"""
