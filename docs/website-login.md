# DSH Secure Sign-in plugin

English | [中文](website-login.zh.md)

When a website needs a password, the agent can open a Secure Sign-in card with its public HTTPS login URL. The separate Vault origin receives the form and only lets the configured DSH origin embed it. Enter the credentials or select a saved login and approve its use. Saving is off by default. In DSH Settings → Vault, you can search, add, update, and delete logins. Deleting a password does not log out a session already shared with a workspace.

1. Give the gateway two distinct HTTPS hostnames, for example `dsh.example.com` and `vault.example.com`. Point both at the same gateway process and preserve each `Host` in the reverse proxy. Reserve the Vault hostname for the gateway. The Vault and login sites use the default HTTPS port. Vault sessions require separate DSH authentication.
2. Set `GATEWAY_PUBLIC_URL=https://dsh.example.com`, `WEBSITE_LOGIN_ORIGIN=https://vault.example.com`, and a stable independent `WEBSITE_LOGIN_VAULT_KEY` (for example, generate it with `openssl rand -hex 32`). If a proxy terminates HTTPS, set `GATEWAY_SANDBOX_CALLBACK_URL` to the gateway address reachable from the sandbox. `WEBSITE_LOGIN_SITES_FILE` is optional. Use [the site example](../gateway/website-login.example.json) only when you want a specific alias, selectors, and explicit success criteria.
3. From `gateway/`, run `uv run --with-requirements requirements-website-login.txt playwright install --with-deps chromium` as the gateway's runtime user, then use the normal `./run.sh`. The runtime must support Chromium's process sandbox. Keep the gateway-to-hub connection on a trusted network, and disable request body capture, Playwright protocol logging, and tracing. Use a single gateway process: requests are stored in memory.
4. Rebuild and deploy the sandbox image, assign Secure Sign-in to selected users or groups, and restart their workspaces. Use an image with the browser hub and assign the workspace browser plugin. Verify sign-in with a test account before enabling it for users.

Two execution modes are supported via `WEBSITE_LOGIN_MODE`:
- **`gateway` (default)**: Website passwords travel through the Vault form to the gateway-controlled login browser and hand off only `Secure`, `HttpOnly` cookies to the workspace.
- **`sandbox`**: The gateway fills credentials directly into the active workspace browser via CDP (supporting nested iframes, password-tab switching, and two-step login forms), and automatically opens the Remote browser tab if a secondary challenge (CAPTCHA, slider, QR, or 2FA) requires user takeover. Vault passwords are encrypted in the gateway database and never exposed to the agent.
