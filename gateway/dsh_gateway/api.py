"""JSON API for the portal and admin console.

/api/auth/*   sign in and out
/api/me/*     the signed-in user's sandbox, password, and API key
/api/admin/*  administrators only: users, groups, plugin catalog, sandboxes, usage, audit
"""

from __future__ import annotations

import asyncio
import shutil
import sqlite3
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .auth import (
    DUMMY_HASH, MIN_PASSWORD_LENGTH, USERNAME, hash_password, mask_key, new_session_token, token_hash,
    verify_password,
)
from .db import User
from .gateway import Gateway
from .images import DSH_VERSION, RUNTIME, compatibility_problem
from .policy import validate_plugin
from .proxy import GATEWAY_COOKIE

router = APIRouter(prefix="/api")


def gw(request: Request) -> Gateway:
    return request.app.state.gw


def signed_in(request: Request) -> User:
    user = gw(request).session_user(request)
    if user is None:
        raise HTTPException(401, "未登录或登录已过期")
    return user


def admin(user: User = Depends(signed_in)) -> User:
    if not user.is_admin:
        raise HTTPException(403, "需要管理员权限")
    return user


def _check_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(400, f"密码至少 {MIN_PASSWORD_LENGTH} 位")


def _user_json(g: Gateway, user: User) -> dict[str, Any]:
    group = g.db.get_group(user.group_id)
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "disabled": user.disabled,
        "group_id": user.group_id,
        "group_name": group["name"] if group else "",
        "has_api_key": user.has_api_key,
        "created_at": user.created_at,
        "last_login_at": user.last_login_at,
    }


# Auth

class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/auth/login")
async def login(body: LoginBody, request: Request, response: Response) -> dict[str, Any]:
    g = gw(request)
    username = body.username.strip().lower()
    user = g.db.get_user_by_name(username)
    stored = g.db.password_hash(user.id) if user else None
    valid = verify_password(body.password, stored or DUMMY_HASH)
    if user is None or not valid:
        raise HTTPException(401, "用户名或密码错误")
    if user.disabled:
        raise HTTPException(403, "账号已停用，请联系管理员")
    token = new_session_token()
    g.db.create_session(token_hash(token), user.id, g.settings.session_ttl_s)
    g.db.touch_login(user.id)
    g.db.purge_expired_sessions()
    g.db.audit(user.username, "login")
    response.set_cookie(
        GATEWAY_COOKIE, token, max_age=g.settings.session_ttl_s, httponly=True, samesite="lax", path="/",
        secure=g.settings.secure_cookies,
    )
    return _user_json(g, user)


@router.post("/auth/logout")
async def logout(request: Request, response: Response) -> dict[str, Any]:
    """Sign out and release the sandbox: its state is saved and the machine destroyed."""
    g = gw(request)
    user = g.session_user(request)
    if user is not None:
        await g.manager.release(user.username, "logout")
        g.db.audit(user.username, "logout")
    token = request.cookies.get(GATEWAY_COOKIE)
    if token:
        g.db.delete_session(token_hash(token))
    response.delete_cookie(GATEWAY_COOKIE, path="/")
    return {"ok": True}


# Me

@router.get("/me")
async def me(request: Request, user: User = Depends(signed_in)) -> dict[str, Any]:
    g = gw(request)
    group = g.db.get_group(user.group_id) or {}
    key = g.user_api_key(user)
    return {
        **_user_json(g, user),
        "api_key_hint": mask_key(key) if key else None,
        "shared_key_available": bool(group.get("allow_shared_key")) and bool(g.settings.deepseek_api_key),
        "quota": {
            "daily_request_limit": group.get("daily_request_limit", 0),
            "requests_today": g.db.requests_today(user.id),
        },
        "plugins": [
            {"name": p["name"], "kind": p["kind"], "description": p["description"]}
            for p in g.db.effective_plugins(user)
        ],
        "sandbox": g.sandbox_info(user.username),
        "workspace_saved": g.manager.has_saved_state(user.username),
    }


@router.get("/me/sandbox")
async def my_sandbox(request: Request, user: User = Depends(signed_in)) -> dict[str, Any]:
    return gw(request).sandbox_info(user.username)


@router.post("/me/sandbox/start")
async def start_my_sandbox(request: Request, user: User = Depends(signed_in)) -> dict[str, Any]:
    g = gw(request)
    g.manager.start_in_background(user.username, g.policy_for(user))
    # Yield once so the task takes the user's lock before status is read.
    await asyncio.sleep(0)
    return g.sandbox_info(user.username)


@router.post("/me/sandbox/release")
async def release_my_sandbox(request: Request, user: User = Depends(signed_in)) -> dict[str, Any]:
    """Begin saving and releasing; poll GET /me/sandbox until the status is stopped."""
    g = gw(request)
    g.manager.release_in_background(user.username, "released by user")
    await asyncio.sleep(0)
    g.db.audit(user.username, "release-sandbox")
    return g.sandbox_info(user.username)


class PasswordBody(BaseModel):
    old_password: str
    new_password: str


@router.post("/me/password")
async def change_password(body: PasswordBody, request: Request, user: User = Depends(signed_in)) -> dict[str, Any]:
    g = gw(request)
    if not verify_password(body.old_password, g.db.password_hash(user.id) or DUMMY_HASH):
        raise HTTPException(400, "原密码不正确")
    _check_password(body.new_password)
    g.db.set_password_hash(user.id, hash_password(body.new_password))
    g.db.audit(user.username, "change-password")
    return {"ok": True}


class ApiKeyBody(BaseModel):
    api_key: str = Field(min_length=8, max_length=512)


@router.put("/me/api-key")
async def set_api_key(body: ApiKeyBody, request: Request, user: User = Depends(signed_in)) -> dict[str, Any]:
    g = gw(request)
    key = body.api_key.strip()
    g.db.set_api_key_enc(user.id, g.secrets.encrypt(key))
    g.db.audit(user.username, "set-api-key")
    return {"api_key_hint": mask_key(key)}


@router.delete("/me/api-key")
async def clear_api_key(request: Request, user: User = Depends(signed_in)) -> dict[str, Any]:
    g = gw(request)
    g.db.set_api_key_enc(user.id, None)
    g.db.audit(user.username, "clear-api-key")
    return {"api_key_hint": None}


# Admin: overview

@router.get("/admin/overview")
async def overview(request: Request, _: User = Depends(admin)) -> dict[str, Any]:
    g = gw(request)
    users = g.db.list_users()
    usage = g.db.usage_today()
    return {
        "users": len(users),
        "disabled_users": sum(u.disabled for u in users),
        "groups": len(g.db.list_groups()),
        "plugins": len(g.db.list_plugins()),
        "running_sandboxes": len(g.manager.snapshot()),
        "requests_today": sum(u["requests"] for u in usage.values()),
        "tokens_today": sum(u["input_tokens"] + u["output_tokens"] for u in usage.values()),
        "shared_key_configured": bool(g.settings.deepseek_api_key),
        "backend": g.settings.backend,
        "default_image": g.settings.docker_image if g.settings.backend == "docker" else g.settings.e2b_template,
        "instance_id": g.settings.instance_id,
        "usage_by_day": g.db.usage_by_day(14),
    }


# Admin: users

@router.get("/admin/users")
async def list_users(request: Request, _: User = Depends(admin)) -> list[dict[str, Any]]:
    g = gw(request)
    usage = g.db.usage_today()
    return [
        {
            **_user_json(g, u),
            "plugin_ids": g.db.user_plugin_ids(u.id),
            "usage_today": usage.get(u.id, {"requests": 0, "input_tokens": 0, "output_tokens": 0}),
            "sandbox": g.sandbox_info(u.username),
        }
        for u in g.db.list_users()
    ]


class CreateUserBody(BaseModel):
    username: str
    password: str
    display_name: str = ""
    role: Literal["admin", "user"] = "user"
    group_id: int | None = None


@router.post("/admin/users", status_code=201)
async def create_user(body: CreateUserBody, request: Request, actor: User = Depends(admin)) -> dict[str, Any]:
    g = gw(request)
    username = body.username.strip().lower()
    if not USERNAME.match(username):
        raise HTTPException(400, "用户名只能包含小写字母、数字和连字符，以字母或数字开头，最长 31 位")
    _check_password(body.password)
    group_id = body.group_id or g.db.default_group_id()
    if g.db.get_group(group_id) is None:
        raise HTTPException(400, "用户组不存在")
    try:
        user_id = g.db.create_user(username, hash_password(body.password), body.role, group_id, body.display_name)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "用户名已存在") from None
    g.db.audit(actor.username, "create-user", username, f"role={body.role}")
    created = g.db.get_user(user_id)
    assert created is not None
    return _user_json(g, created)


class UpdateUserBody(BaseModel):
    display_name: str | None = None
    role: Literal["admin", "user"] | None = None
    group_id: int | None = None
    disabled: bool | None = None
    password: str | None = None
    plugin_ids: list[int] | None = None


def _user_or_404(g: Gateway, user_id: int) -> User:
    user = g.db.get_user(user_id)
    if user is None:
        raise HTTPException(404, "用户不存在")
    return user


@router.patch("/admin/users/{user_id}")
async def update_user(
    user_id: int, body: UpdateUserBody, request: Request, actor: User = Depends(admin)
) -> dict[str, Any]:
    g = gw(request)
    user = _user_or_404(g, user_id)
    changes = body.model_dump(exclude_none=True, exclude={"password", "plugin_ids"})
    demoting = changes.get("role") == "user" or changes.get("disabled") is True
    if user.is_admin and not user.disabled and demoting and g.db.count_admins() <= 1:
        raise HTTPException(400, "至少要保留一个启用的管理员")
    if "group_id" in changes and g.db.get_group(changes["group_id"]) is None:
        raise HTTPException(400, "用户组不存在")
    g.db.update_user(user_id, changes)
    if body.password is not None:
        _check_password(body.password)
        g.db.set_password_hash(user_id, hash_password(body.password))
        g.db.delete_user_sessions(user_id)
    if body.plugin_ids is not None:
        g.db.set_user_plugins(user_id, body.plugin_ids)
    if body.disabled:
        g.db.delete_user_sessions(user_id)
        await g.manager.release(user.username, "account disabled")
    detail = ", ".join(sorted(changes)) + (", password" if body.password else "") + (", plugins" if body.plugin_ids is not None else "")
    g.db.audit(actor.username, "update-user", user.username, detail)
    updated = g.db.get_user(user_id)
    assert updated is not None
    return _user_json(g, updated)


@router.delete("/admin/users/{user_id}")
async def delete_user(user_id: int, request: Request, purge: bool = False, actor: User = Depends(admin)) -> dict[str, Any]:
    """Delete the account; with purge=true also delete the user's saved sandbox data."""
    g = gw(request)
    user = _user_or_404(g, user_id)
    if user.id == actor.id:
        raise HTTPException(400, "不能删除自己")
    if user.is_admin and g.db.count_admins() <= 1:
        raise HTTPException(400, "至少要保留一个启用的管理员")
    await g.manager.release(user.username, "account deleted")
    g.db.delete_user(user_id)
    if purge:
        await asyncio.to_thread(shutil.rmtree, g.settings.state_dir / user.username, ignore_errors=True)
    g.db.audit(actor.username, "delete-user", user.username, "purged data" if purge else "kept data")
    return {"ok": True}


# Admin: groups

class GroupBody(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    description: str | None = None
    mem_limit: str | None = Field(default=None, pattern=r"^\d+(\.\d+)?[kmgKMG]?$")
    cpus: float | None = Field(default=None, gt=0, le=64)
    idle_timeout_s: int | None = Field(default=None, ge=60)
    max_lifetime_s: int | None = Field(default=None, ge=300)
    allow_shared_key: bool | None = None
    daily_request_limit: int | None = Field(default=None, ge=0)
    allowed_models: list[str] | None = None
    plugin_ids: list[int] | None = None
    # 0 selects the default image.
    image_id: int | None = Field(default=None, ge=0)


def _check_image_id(g: Gateway, image_id: int | None) -> None:
    if image_id and g.db.get_image(image_id) is None:
        raise HTTPException(400, "镜像不存在")


@router.get("/admin/groups")
async def list_groups(request: Request, _: User = Depends(admin)) -> list[dict[str, Any]]:
    return gw(request).db.list_groups()


@router.post("/admin/groups", status_code=201)
async def create_group(body: GroupBody, request: Request, actor: User = Depends(admin)) -> dict[str, Any]:
    g = gw(request)
    if not body.name:
        raise HTTPException(400, "请填写组名")
    _check_image_id(g, body.image_id)
    s = g.settings
    values = {
        "mem_limit": s.mem_limit, "cpus": s.cpus, "idle_timeout_s": s.idle_timeout_s,
        "max_lifetime_s": s.max_lifetime_s, **body.model_dump(exclude_none=True, exclude={"plugin_ids"}),
    }
    try:
        group_id = g.db.create_group(values)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "组名已存在") from None
    if body.plugin_ids is not None:
        g.db.set_group_plugins(group_id, body.plugin_ids)
    g.db.audit(actor.username, "create-group", body.name)
    return g.db.get_group(group_id) or {}


@router.patch("/admin/groups/{group_id}")
async def update_group(group_id: int, body: GroupBody, request: Request, actor: User = Depends(admin)) -> dict[str, Any]:
    g = gw(request)
    group = g.db.get_group(group_id)
    if group is None:
        raise HTTPException(404, "用户组不存在")
    _check_image_id(g, body.image_id)
    try:
        g.db.update_group(group_id, body.model_dump(exclude_none=True, exclude={"plugin_ids"}))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "组名已存在") from None
    if body.plugin_ids is not None:
        g.db.set_group_plugins(group_id, body.plugin_ids)
    g.db.audit(actor.username, "update-group", group["name"], ", ".join(sorted(body.model_dump(exclude_none=True))))
    return g.db.get_group(group_id) or {}


@router.delete("/admin/groups/{group_id}")
async def delete_group(group_id: int, request: Request, actor: User = Depends(admin)) -> dict[str, Any]:
    g = gw(request)
    group = g.db.get_group(group_id)
    if group is None:
        raise HTTPException(404, "用户组不存在")
    if group_id == g.db.default_group_id():
        raise HTTPException(400, "默认用户组不能删除")
    if group["user_count"]:
        raise HTTPException(400, "组内还有用户，请先把他们移到其他组")
    g.db.delete_group(group_id)
    g.db.audit(actor.username, "delete-group", group["name"])
    return {"ok": True}


# Admin: plugin catalog

class PluginBody(BaseModel):
    key: str | None = None
    kind: Literal["bundle", "mcp", "patch"] | None = None
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = None
    config: dict[str, Any] | None = None


@router.get("/admin/plugins")
async def list_plugins(request: Request, _: User = Depends(admin)) -> list[dict[str, Any]]:
    return gw(request).db.list_plugins()


@router.post("/admin/plugins", status_code=201)
async def create_plugin(body: PluginBody, request: Request, actor: User = Depends(admin)) -> dict[str, Any]:
    g = gw(request)
    if body.key is None or body.kind is None or not body.name or body.config is None:
        raise HTTPException(400, "请填写标识、类型、名称和配置")
    try:
        config = validate_plugin(body.kind, body.key, body.config)
    except ValueError as err:
        raise HTTPException(400, str(err)) from None
    try:
        plugin_id = g.db.create_plugin({**body.model_dump(exclude_none=True), "config": config})
    except sqlite3.IntegrityError:
        raise HTTPException(409, "标识已存在") from None
    g.db.audit(actor.username, "create-plugin", body.key, body.kind)
    return g.db.get_plugin(plugin_id) or {}


@router.patch("/admin/plugins/{plugin_id}")
async def update_plugin(plugin_id: int, body: PluginBody, request: Request, actor: User = Depends(admin)) -> dict[str, Any]:
    g = gw(request)
    plugin = g.db.get_plugin(plugin_id)
    if plugin is None:
        raise HTTPException(404, "插件不存在")
    merged = {**plugin, **body.model_dump(exclude_none=True)}
    try:
        merged["config"] = validate_plugin(merged["kind"], merged["key"], merged["config"])
    except ValueError as err:
        raise HTTPException(400, str(err)) from None
    try:
        g.db.update_plugin(plugin_id, merged)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "标识已存在") from None
    g.db.audit(actor.username, "update-plugin", merged["key"])
    return g.db.get_plugin(plugin_id) or {}


@router.delete("/admin/plugins/{plugin_id}")
async def delete_plugin(plugin_id: int, request: Request, actor: User = Depends(admin)) -> dict[str, Any]:
    g = gw(request)
    plugin = g.db.get_plugin(plugin_id)
    if plugin is None:
        raise HTTPException(404, "插件不存在")
    g.db.delete_plugin(plugin_id)
    g.db.audit(actor.username, "delete-plugin", plugin["key"])
    return {"ok": True}


# Admin: images

class ImageBody(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    ref: str | None = Field(default=None, min_length=1, max_length=300, pattern=r"^\S+$")
    description: str | None = None


async def _inspect_compatible(g: Gateway, ref: str) -> dict[str, str]:
    """The image's labels after the compatibility check; HTTP 400 explaining any problem."""
    backend = g.manager.backend
    try:
        candidate = await backend.inspect_image(ref)
        default = await backend.inspect_image(None)
    except ValueError as err:
        raise HTTPException(400, str(err)) from None
    if candidate is None or default is None:
        # The backend cannot inspect images (hosted templates): accept as declared.
        return {}
    problem = compatibility_problem(candidate, default)
    if problem:
        raise HTTPException(400, problem)
    return candidate.labels


@router.get("/admin/images")
async def list_images(request: Request, _: User = Depends(admin)) -> list[dict[str, Any]]:
    return gw(request).db.list_images()


@router.post("/admin/images", status_code=201)
async def create_image(body: ImageBody, request: Request, actor: User = Depends(admin)) -> dict[str, Any]:
    """Register an image after checking it exists (pulling it if needed) and matches the default image."""
    g = gw(request)
    if not body.name or not body.ref:
        raise HTTPException(400, "请填写名称和镜像地址")
    labels = await _inspect_compatible(g, body.ref)
    try:
        image_id = g.db.create_image(
            body.name, body.ref, body.description or "", labels.get(DSH_VERSION, ""), labels.get(RUNTIME, "")
        )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "名称或镜像地址已登记") from None
    g.db.audit(actor.username, "create-image", body.ref)
    return g.db.get_image(image_id) or {}


@router.patch("/admin/images/{image_id}")
async def update_image(image_id: int, body: ImageBody, request: Request, actor: User = Depends(admin)) -> dict[str, Any]:
    """Rename or describe an image. The reference is fixed: register a new tag instead and switch groups to it."""
    g = gw(request)
    image = g.db.get_image(image_id)
    if image is None:
        raise HTTPException(404, "镜像不存在")
    if body.ref is not None and body.ref != image["ref"]:
        raise HTTPException(400, "镜像地址登记后不能修改；请登记新版本，再把用户组切过去")
    try:
        g.db.update_image(image_id, body.model_dump(exclude_none=True, exclude={"ref"}))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "名称已存在") from None
    g.db.audit(actor.username, "update-image", image["ref"])
    return g.db.get_image(image_id) or {}


@router.post("/admin/images/{image_id}/check")
async def check_image(image_id: int, request: Request, actor: User = Depends(admin)) -> dict[str, Any]:
    """Re-check that the image is present (pulling it if needed) and still compatible."""
    g = gw(request)
    image = g.db.get_image(image_id)
    if image is None:
        raise HTTPException(404, "镜像不存在")
    labels = await _inspect_compatible(g, image["ref"])
    g.db.update_image(image_id, {
        "dsh_version": labels.get(DSH_VERSION, image["dsh_version"]),
        "runtime": labels.get(RUNTIME, image["runtime"]),
        "checked_at": time.time(),
    })
    return g.db.get_image(image_id) or {}


@router.delete("/admin/images/{image_id}")
async def delete_image(image_id: int, request: Request, actor: User = Depends(admin)) -> dict[str, Any]:
    g = gw(request)
    image = g.db.get_image(image_id)
    if image is None:
        raise HTTPException(404, "镜像不存在")
    if image["group_count"]:
        raise HTTPException(400, "还有用户组在使用这个镜像，请先把它们切到其他镜像")
    g.db.delete_image(image_id)
    g.db.audit(actor.username, "delete-image", image["ref"])
    return {"ok": True}


# Admin: sandboxes, audit

@router.get("/admin/sandboxes")
async def list_sandboxes(request: Request, _: User = Depends(admin)) -> list[dict[str, Any]]:
    g = gw(request)
    return [{"username": name, **g.sandbox_info(name)} for name in g.manager.active_users()]


@router.post("/admin/sandboxes/{username}/release")
async def release_sandbox(username: str, request: Request, actor: User = Depends(admin)) -> dict[str, Any]:
    g = gw(request)
    g.manager.release_in_background(username, f"released by admin {actor.username}")
    await asyncio.sleep(0)
    g.db.audit(actor.username, "release-sandbox", username)
    return g.sandbox_info(username)


@router.post("/admin/sandboxes/{username}/restart")
async def restart_sandbox(username: str, request: Request, actor: User = Depends(admin)) -> dict[str, Any]:
    """Save and release a running sandbox, then start it with the user's current policy."""
    g = gw(request)
    user = g.db.get_user_by_name(username)
    if user is None:
        raise HTTPException(404, "用户不存在")
    if g.manager.status(username) != "running":
        raise HTTPException(400, "工作空间正在休眠，下次打开时会自动使用新配置")
    g.manager.restart_in_background(username, g.policy_for(user), f"restarted by admin {actor.username}")
    await asyncio.sleep(0)
    g.db.audit(actor.username, "restart-sandbox", username)
    return g.sandbox_info(username)


@router.get("/admin/audit")
async def audit_log(request: Request, limit: int = 200, _: User = Depends(admin)) -> list[dict[str, Any]]:
    return gw(request).db.list_audit(min(max(limit, 1), 1000))
