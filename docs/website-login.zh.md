# DSH 安全登录插件

[English](website-login.md) | 中文

如果你让 Agent 在某个网站工作，而该网站需要密码，启用插件后 Agent 会优先发起「安全登录」。公开的 HTTPS 登录地址不需要逐站配置。点击「打开表单」，表单在聊天卡片里展开，由独立 Vault 域名接收密码。核对目标网站后，可以输入账号密码，或选择已保存的账号。保存默认不勾选，使用已保存的密码也需要你授权。在 DSH 原生「设置 → 密码保险库」可以搜索、新建、更新密码和删除登录；删除密码不会注销已经交接的网站会话。

## 在 Mac 上本地联调（OrbStack）

先按平时的方法启动 OpenSandbox。如果普通模式的网关已经在运行，只在网关终端按 `Ctrl+C`，保持 OpenSandbox 运行；然后从 `gateway/` 重新启动：

```sh
./run.sh --test-website-login
```

这会沿用 `gateway/.env` 里的后端、数据库和用户数据，以独立标签构建测试镜像，并启动一个只接受假账号的网站。`.env` 不会被改写。如果网页尚未构建，在仓库根目录运行 `pnpm --dir web build`。

首次使用 OrbStack HTTPS，打开 [OrbStack 证书安装页](https://orb.local)，按提示信任本机证书。OrbStack 须开启 **Settings → Network → Allow access to container domains & IPs**。两个代理域名和测试站点由 [OrbStack 的容器域名](https://docs.orbstack.dev/docker/domains)和 [HTTPS](https://docs.orbstack.dev/features/https)提供。

1. 打开 [本地管理台](https://dsh-signin-web.local/admin)，用平时的 DSH 管理员账号登录。在 **用户组 → default → 编辑** 勾选「安全登录」，保留「远程浏览器」。如果工作区已开，重启它。Agent 使用现有的 DeepSeek API Key 发起工具调用。
2. 在 DSH 对话发：`请调用 website_login_sites，然后对 demo 调用 request_website_login；授权成功后，用远程浏览器打开 https://dsh-signin-fixture.local/dashboard，检查页面是否显示 DSH Secure Login OK。` 不要把账号密码发到对话里。
3. 点「打开安全表单」，在展开的卡片里用相同的 DSH 账号验证身份。核对目标是 `dsh-signin-fixture.local`，填测试网站账号 `demo`、密码 `dsh-test-only`。可以勾选保存，再点「登录并授权」。远程浏览器看到 **DSH Secure Login OK** 就代表会话交接成功。
4. 再发起一次登录，检查能否使用 Vault 里的 `demo`。结束后可在 Vault 首页删除测试账号，在管理台取消测试分配。在网关终端按 `Ctrl+C`，从 `gateway/` 运行 `docker compose -f dev/website-login/compose.yaml down`，然后用普通的 `./run.sh` 恢复日常启动。

只想先验证网关逻辑，可在根目录运行 `gateway/.venv/bin/python -m pytest -q gateway/tests/test_website_login.py`。它不需要 Docker、网站或模型 Key。

## 配置自己的部署

1. 给 DSH 网关准备两个不同的 HTTPS 主机名。例如 `dsh.example.com` 用于正常工作区，`vault.example.com` 用于安全登录。两个地址都转到同一个网关进程，反向代理必须保留各自的 `Host`。Vault 主机名应专用，不要将它的路径转发到工作区。DSH 和 Vault 都必须走 HTTPS，Vault 和目标网站走默认 HTTPS 端口。Vault 独立验证 DSH 身份，浏览器不会把 DSH 工作区登录 cookie 用作 Vault 的登录凭证。
2. 在网关 `.env` 设 `GATEWAY_PUBLIC_URL=https://dsh.example.com`、`WEBSITE_LOGIN_ORIGIN=https://vault.example.com`，以及独立且长期保存的 `WEBSITE_LOGIN_VAULT_KEY`（例如用 `openssl rand -hex 32` 生成）。若 HTTPS 在代理处终止，把 `GATEWAY_SANDBOX_CALLBACK_URL` 指向沙箱可访问的网关监听地址。`WEBSITE_LOGIN_SITES_FILE` 可留空；确实要给特定站点配置选择器和成功路径时，才参考 [sites 示例](../gateway/website-login.example.json)。
3. 在 `gateway/` 下以网关运行账号执行 `uv run --with-requirements requirements-website-login.txt playwright install --with-deps chromium`，之后用普通的 `./run.sh` 启动。运行环境须支持 Chromium 的进程沙箱，网关到工作区浏览器的连接须在可信网络上。生产环境不要采集表单请求体、Playwright 协议或浏览器 trace。当前授权请求保存在进程内，使用单进程运行网关。
4. 重建并部署沙箱镜像，在管理台将「安全登录」分配给选定用户或用户组，再重启对应的工作空间。需要使用带浏览器 Hub 的镜像，并确保用户拥有工作空间浏览器插件。在对话中可以直接说「用安全表单登录 `https://example.com/login`」，或从原生「设置 → 密码保险库」先保存账号。

网站密码由安全表单交给隔离的登录浏览器，并提交到已确认的站点；Agent 工具只收到状态。保存的密码用独立密钥加密，Vault 页面只显示站点和账号。工作区收到的会话 cookie 可代表你操作网站。通用模式只连接已确认的公网 HTTPS 域名，拒绝内网、跨域登录和同域外的依赖。它会识别单页、同域 `POST` 的密码表单，要求登录后进入同域的新页面并产生新的或变化的 `Secure`、`HttpOnly` 会话 cookie。扫码、OAuth/SSO、验证码、MFA、多步骤登录或 `localStorage` 会话可能无法完成，不能用它代替站点自己的验证流程。
