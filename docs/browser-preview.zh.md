# 浏览器预览

[English](browser-preview.md) | 中文

每个工作空间里有一个常驻的 Chromium。agent 通过 Playwright MCP 操作它，用户在 dsh 右侧边栏的「浏览器预览」里实时看到同一个浏览器，并且可以随时接手：点击、滚动、输入（包括中文输入法）、切换标签页、跳转网址。典型用法是 agent 碰到登录或验证码时由用户完成，或者用户想看 agent 到底在网页上做了什么。

本文档说明这个功能的使用、实现、部署和限制。项目整体说明见 [README](../README.zh.md)。

## 目录

- [用户看到什么](#用户看到什么)
- [管理员怎么开启](#管理员怎么开启)
- [架构](#架构)
- [各部分的实现](#各部分的实现)
- [数据与安全](#数据与安全)
- [升级与版本](#升级与版本)
- [已知限制](#已知限制)
- [故障排查](#故障排查)
- [验证记录](#验证记录)
- [为什么这样设计](#为什么这样设计)
- [相关文件](#相关文件)

## 用户看到什么

| 场景 | 表现 |
|---|---|
| agent 开始操作浏览器 | 右侧边栏自动打开「浏览器预览」标签（侧边栏收起时也会展开；已打开时切到前面），状态显示蓝点"Agent 正在操作"，画面实时跟随 |
| agent 停止操作约 3 秒 | 状态变回绿点"你可以直接点击和输入" |
| 用户接手 | 直接在画面上点击、滚动、打字；中文输入法、粘贴都可以；支持 Enter、Backspace、Tab、方向键和 Ctrl/Cmd 快捷键 |
| 工具栏 | 后退、前进、刷新、地址栏（回车跳转，裸域名自动补 https）、新标签页；多个标签页时显示标签条，可切换和关闭 |
| 网页弹出 alert / confirm / prompt | 显示在面板里，点确定或取消 |
| 手动打开 | 右侧边栏引导页的「浏览器预览」（蓝色小地球图标，和"工作区文件""新建终端"同一套） |
| 语言 | 跟随 dsh 设置里的语言：中文显示「浏览器预览」，英文显示「Browser preview」；dsh 的"跟随系统"会随系统语言变化 |
| 工作空间休眠后再回来 | 浏览器的 cookie、登录状态、历史都还在 |

agent 在所有会话里都有浏览器工具，工具名为 `mcp__browser__*`（如 `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`）。

## 管理员怎么开启

1. 管理后台 → **插件与 MCP** → **添加工作空间浏览器**。模板会填好：类型「dsh 插件」，spec `file:/usr/local/lib/dsh-cloud/workspace-browser`。
2. 在同一个表单里勾选要开启的**用户组**（或者之后在「用户」里单独分配给某个人）。没有分配的条目在列表里会标红"未分配，不会生效"。
3. 保存后按提示**立即重启**受影响的工作空间，或者等用户下次登录。

前提：工作空间镜像基于本项目的基础镜像（`sandbox-image/base`），里面已经有 Chromium、浏览器中转服务、`@playwright/mcp` 和这个插件，**开启时不需要联网**。网关需要是包含本功能的版本（转发路由和 3081 端口）。

## 架构

```
用户浏览器（dsh Web 页面）
 ├─ 右侧边栏「浏览器预览」──── WS /u/<用户>/_dsh-cloud/browser ────────┐
 └─ 页面级观察连接 ─────────── WS /u/<用户>/_dsh-cloud/browser?watch=1 ─┤
                                                                       ▼
网关（FastAPI）：校验会话属于该用户本人，转发到沙箱的 3081 端口
                                                                       ▼
沙箱（每个用户一个容器）
 ├─ 浏览器中转服务 browser-hub（Node）
 │    ├─ :3081        给用户：画面帧、标签页、输入、弹窗（自定义小协议）
 │    ├─ 127.0.0.1:9223  给 agent：CDP 透传代理，同时记录"agent 正在操作"
 │    └─ 管理 Chromium：首次使用时启动，headless，调试端口 127.0.0.1:9222
 ├─ Chromium（用户数据 ~/.config/dsh-workspace-browser，随工作空间保存）
 └─ dsh
      ├─ dsh-mcp-client 行：playwright-mcp --cdp-endpoint http://127.0.0.1:9223
      └─ 客户端插件 dsh-cloud-workspace-browser：右侧边栏标签 + 自动弹出
```

agent 和用户连的是**同一个 Chromium**，所以用户看到的就是 agent 正在操作的页面，用户的操作 agent 下一步也会看到。

## 各部分的实现

### 浏览器中转服务（`sandbox-image/base/browser-hub/hub.mjs`）

- **Chromium 生命周期**：第一次有 agent 或用户连接时才启动，空闲时只有一个很小的 Node 进程。启动前清理 profile 里残留的 `SingletonLock` 等锁文件（工作空间从快照恢复后，旧容器留下的锁会让 Chromium 拒绝启动）。参数包括 `--headless=new`、`--disable-dev-shm-usage`（容器的 /dev/shm 只有 64 MB）、`--window-size=1280,800`、`--lang=zh-CN`。容器里 Chromium 无法创建自己的进程沙箱，镜像通过 `/etc/chromium.d/dsh-cloud` 默认加上 `--no-sandbox`，容器本身就是隔离边界。
- **agent 端点（127.0.0.1:9223）**：对 `/json/*` 和 WebSocket 做 CDP 透传，并把返回里的 9222 改写成 9223。agent 每发一条 CDP 消息就记一次活跃，3 秒无消息视为停止，并广播给所有观察者。
- **用户端点（:3081）**：不暴露原始 CDP，只提供一组 JSON 消息：

  | 方向 | 消息 |
  |---|---|
  | 服务 → 面板 | `frame`（JPEG 画面，来自 `Page.startScreencast`）、`tabs`（标签页列表、能否前进后退）、`agent`（是否在操作）、`dialog` / `dialog-closed`、`status`（starting / ready / error） |
  | 面板 → 服务 | `mouse`（按下、抬起、移动、滚轮）、`key`（特殊键和快捷键）、`text`（打字、粘贴、输入法结果，用 `Input.insertText`）、`navigate` / `back` / `forward` / `reload`、`activate` / `new-tab` / `close-tab`、`dialog`（确定/取消） |

  所有面板共用一个 CDP 连接；最后一个面板关闭时停止推送画面。agent 新开标签页时，画面自动切过去。
- **观察连接（`?watch=1`）**：只接收 `agent` 事件，不启动 Chromium、不推画面，供 dsh 页面判断何时自动弹出面板。

### 入口脚本（`sandbox-image/base/entrypoint.sh`）

同时启动中转服务和 dsh，并作为一个小的守护进程：收到停止信号时转发给两者并等待退出。这样工作空间休眠时 Chromium 能先把 cookie 等数据写盘，再打包用户目录。实测休眠耗时约 2 秒。

### 网关（`gateway/dsh_gateway/app.py`、`proxy.py`）

- 路由 `/u/<用户>/_dsh-cloud/browser`，注册在通用的 dsh 转发路由之前。
- 只允许该用户本人的有效会话连接：不是本人返回关闭码 4401，工作空间没有中转服务（比如由旧版网关创建的容器）返回 4404。
- 转发时保留查询参数（`?watch=1`），用户在面板里的操作计入工作空间的活跃时间。
- Docker 后端把容器的 3081 端口发布在宿主机的 `127.0.0.1` 上，和 dsh 的 3080 一样外部无法直接访问。

### dsh 组合包和客户端插件（`sandbox-image/base/workspace-browser/`）

| 文件 | 作用 |
|---|---|
| `package.json` | 同时声明 `dsh.bundle`（组合包，带自己的补丁文件）和 `dsh.client`（浏览器端插件，依赖右侧边栏） |
| `cordis.patch.yml` | 插入两行：`@deepseek-ai/dsh-mcp-client`（`serverName: browser`，运行镜像里的 `playwright-mcp --cdp-endpoint http://127.0.0.1:9223 --image-responses omit`）和插件自身 |
| `index.js` | 宿主端，空实现；存在的意义是让 dsh 的客户端模块表加载 `client.js` |
| `client.js` | 浏览器端插件，直接按 dsh 客户端模块格式手写（`window.__ModuleLoader__.load({ id, factory(require) })`），React 和 dsh 的图标从 dsh 的共享模块表获取，不需要构建 |

`client.js` 做了这些事：

- 用 `ctx.locale.register` 注册中英文文案，跟随 dsh 的语言设置；
- 用 `ctx.sidebarRightTabs.register` 注册标签类型和引导页入口（图标 `GuideArtworkBrowser`）；
- 往 `sidebar.right.pane.tab` 插槽注册面板内容，往 `sidebar.right.pane.tab.title` 插槽注册标签标题（`IconGlobeOutlineRegular` + 名称）。标题文字右侧留出 16px 并以省略号截断，因为 dsh 标签的文字区域会伸到关闭按钮下面约 14px；
- 保持一个观察连接，agent 开始操作时调用 `ctx.sidebarRight.openTab('workspace-browser')` 打开或切到面板；
- 面板样式与 dsh 自带的 Files、Terminal 面板一致：不铺底色，标题区留白，标题区和画面之间一条细线，画面四周留白并带圆角。

### 下发（`sandbox-image/base/provision.py`）

镜像自带的 `file:` 组合包**在 dsh 启动前**完成安装、更新或重装，不需要联网，dsh 一启动就是正确的配置：

| 情况 | 处理 |
|---|---|
| 第一次分配 | `dsh plugin add file:…` 并加入组合包列表 |
| 镜像里的插件版本变了，依赖没变 | 直接把镜像里的文件复制到已安装的副本上（替换文件，不在原地写，因为已安装的文件是 pnpm 内容仓库的硬链接） |
| 依赖变了 | `dsh plugin remove` 后重新安装 |

下发记录 `~/.dsh-cloud/provisioned.json` 里，`file:` 条目会带上版本号（如 `file:/usr/local/lib/dsh-cloud/workspace-browser#0.4.3`），版本变化就会触发上面的更新。需要从 npm 下载的普通插件仍然在 dsh 启动后后台安装。

## 数据与安全

| 数据 | 位置 | 是否保存 |
|---|---|---|
| 浏览器 cookie、登录状态、历史、本地存储 | `/home/agent/.config/dsh-workspace-browser` | ✅ 随工作空间快照保存，休眠恢复后仍在 |
| 浏览器插件的安装副本 | `/home/agent/.dsh/profiles/web/node_modules/dsh-cloud-workspace-browser` | ✅ |
| Playwright MCP 的输出文件 | `/tmp/playwright-mcp` | ❌ |

- 浏览器调试端口（9222）和 agent 端点（9223）只监听在沙箱内的 `127.0.0.1`。
- 用户端点（3081）只发布在网关宿主机的 `127.0.0.1`，经过网关时校验会话属于该用户本人。
- 用户能看到并操作的只是自己工作空间里的浏览器。浏览器里登录的账号属于该用户的工作空间数据，和其他数据一样随快照保存；上线时应按[持久卷方案](../README.zh.md#上线前必做每个用户一块持久卷)加密存储。

## 升级与版本

- 改了 `workspace-browser/` 里的文件后，**提高 `package.json` 的版本号**，重新构建镜像。用户下次启动工作空间时自动更新。
- 改了中转服务（`browser-hub/`）只需要重建镜像，它属于镜像本身。
- 网关的改动需要重启网关；由旧版网关创建、没有发布 3081 端口的工作空间，重启一次就会用新代码重新创建。
- `client.js` 依赖 dsh 预览阶段的接口：`sidebarRightTabs`、`sidebar.right.pane.tab(.title)` 插槽、`locale`、共享模块 `@deepseek-ai/dsh-client-ui-primitives` 里的图标名称、客户端模块格式。**升级 dsh 后需要回归一次**。验证于 `@deepseek-ai/dsh@0.2.1-rc.2`。

## 已知限制

- **只显示网页内容**：浏览器自身的界面（地址栏、标签栏、下载栏、扩展弹窗、文件选择框等原生对话框）不会显示，地址栏和标签条由面板自己绘制。需要完整桌面时可以另外加 noVNC，两者不冲突。
- **没有互斥**：用户和 agent 可以同时操作，面板只提示"Agent 正在操作"，无法暂停 agent。
- **不带截图给模型**：`--image-responses omit`，因为默认的 DeepSeek 模型读文字；页面结构仍以文字快照返回。换用能看图的模型时去掉这个参数。
- **复制**：可以往页面里粘贴，但不能把网页里选中的文字复制到本机剪贴板。
- **画面**：JPEG 画面帧，网速差时会降帧；画面按面板大小等比缩放。
- **浏览器分辨率**固定为 1280×800。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 面板显示"连接已断开，正在重连…"一直不恢复 | 网关是旧版本，没有浏览器转发路由。重启网关 |
| 面板显示"这个工作空间还没有浏览器" | 工作空间是旧版网关创建的，没有发布 3081 端口。退出登录再登录，或在管理后台重启工作空间 |
| 右侧边栏没有「浏览器预览」 | 插件没有分配给这个用户或他的用户组（插件列表里会标红），或者分配后还没重启工作空间 |
| agent 说没有浏览器工具 | 同上；或者 dsh 启动前插件安装失败，用 `docker logs <容器> \| grep provision` 查看 |
| 画面空白 | 浏览器刚启动，还停在 `about:blank`；在地址栏输入网址，或让 agent 打开页面 |
| 报 "Content Exists Risk" | DeepSeek API 的内容审核拒绝了请求（可能由网页内容触发），不是本功能的问题；新开会话重试，或换一个来源 |

## 验证记录

在本机 Docker（OrbStack）上端到端验证过：

- agent 用 `mcp__browser__*` 打开 Wikipedia、在搜索框输入并打开结果页，面板实时跟随，状态显示"Agent 正在操作"；
- 右侧边栏收起时，agent 一开始操作浏览器，面板自动弹出；
- 已有其他会话的情况下，新会话照样能用浏览器工具；
- 用户在面板里点击搜索框、输入中文"深度求索"并回车，页面正确跳转；
- 休眠约 2 秒完成，cookie 和历史在用户目录快照里；
- 插件从 0.1 到 0.4.3 的几次升级都在 dsh 启动前自动完成；
- dsh 切换中文和英文，面板名称、引导页、工具栏文字随之变化；标签标题不再和关闭按钮重叠。

## 为什么这样设计

- **CDP 实时画面，而不是 noVNC**：只需要看浏览器，不需要整个桌面；CDP 不需要虚拟显示器，资源占用小，画面清晰，中文输入可以直接以文字发送，绕开 VNC 的输入法问题，而且连的就是 agent 用的同一个浏览器。
- **Playwright MCP 作为普通 MCP 挂载，而不是 dsh 的实验性浏览器插件**：dsh 的 `dsh-experimental-browser-use-playwright-mcp` 在 attach 模式下同一时刻只允许一个会话占用浏览器，后开的会话拿不到浏览器工具（实测复现过）。普通 MCP 对所有会话可见，而且 `@playwright/mcp` 打包在镜像里，开启时不需要联网。
- **中转服务不暴露原始 CDP 给浏览器端**：协议更小、更好控制，也方便以后加权限或审计。
- **dsh 原生右侧边栏标签，而不是页面上注入的浮层**：可以停靠、全屏，和 dsh 自带面板行为一致。
- **组合包放在镜像里，以 `file:` 下发**：一个目录条目就能同时挂载 MCP 和面板，管理员只需要分配一个条目。

## 相关文件

```
sandbox-image/base/
├── Dockerfile                    安装 Chromium、中转服务和 @playwright/mcp，复制插件
├── entrypoint.sh                 启动中转服务和 dsh，转发停止信号
├── provision.py                  file: 组合包在 dsh 启动前安装和更新
├── browser-hub/
│   ├── package.json              ws、@playwright/mcp
│   └── hub.mjs                   Chromium 管理、agent CDP 代理、用户端点
└── workspace-browser/
    ├── package.json              dsh.bundle + dsh.client，版本号决定是否更新
    ├── cordis.patch.yml          Playwright MCP 行 + 插件行
    ├── index.js                  宿主端（空实现）
    └── client.js                 右侧边栏「浏览器预览」
gateway/dsh_gateway/
├── app.py                        /u/<用户>/_dsh-cloud/browser 路由
├── proxy.py                      relay_websocket
└── backends/docker_backend.py    发布 3081 端口
web/src/pages/admin/Plugins.tsx   「添加工作空间浏览器」模板、分配给用户组
```
