"""Which images may run workspaces.

A user's home moves between images when their group's image changes, so every
image must come from the same base as the default image: the base image's
labels record its dsh version and runtime (Node image, hence Debian release and
Python), and team images inherit them through FROM.
"""

from __future__ import annotations

from .backends import ImageInfo

CONTRACT = "dsh-cloud.contract"
DSH_VERSION = "dsh-cloud.dsh-version"
RUNTIME = "dsh-cloud.runtime"


def compatibility_problem(candidate: ImageInfo, default: ImageInfo) -> str | None:
    """Why `candidate` cannot replace the default image, or None when it can."""
    labels = candidate.labels
    if labels.get(CONTRACT) != "1":
        return f"{candidate.ref} 不是工作空间镜像（缺少 {CONTRACT} 标签）；请基于 sandbox-image/base 构建"
    for key, what in ((DSH_VERSION, "dsh 版本"), (RUNTIME, "运行时（Node / Debian / Python）")):
        expected = default.labels.get(key)
        if expected and labels.get(key) != expected:
            return (
                f"{candidate.ref} 的{what}是 {labels.get(key) or '未知'}，默认镜像是 {expected}。"
                "不一致会让用户的会话、插件或 venv 在切换后失效；请基于同一个基础镜像重新构建"
            )
    return None
