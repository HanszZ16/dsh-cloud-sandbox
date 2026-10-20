# Browser preview

English | [中文](browser-preview.zh.md)

Each workspace has one long-lived Chromium. The agent operates it through Playwright MCP, and the user sees the same browser live in the "Browser preview" tab of dsh's right sidebar and can take over at any time: click, scroll, type (including with a Chinese input method), switch tabs, and navigate. Typical uses: the user completes a sign-in or CAPTCHA the agent runs into, or watches what the agent is actually doing on a page.

This document covers using, implementing, deploying, and the limits of the feature. For the project as a whole, see the [README](../README.md).

## Contents

- [What users see](#what-users-see)
- [Enabling it](#enabling-it)
- [Architecture](#architecture)
- [How each part works](#how-each-part-works)
- [Data and security](#data-and-security)
- [Upgrades and versions](#upgrades-and-versions)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Verification](#verification)
- [Design decisions](#design-decisions)
- [Files](#files)

## What users see

| Situation | Behavior |
|---|---|
| The agent starts operating the browser | The right sidebar opens the "Browser preview" tab by itself (expanding a collapsed sidebar, or bringing an open tab forward); the status shows a blue dot, "Agent is operating", and the view follows live |
| The agent stops for about 3 seconds | The status returns to a green dot, "Click and type to take over" |
| The user takes over | Click, scroll, and type directly on the view; input methods and paste work; Enter, Backspace, Tab, arrows, and Ctrl/Cmd shortcuts are forwarded |
| Toolbar | Back, forward, reload, an address bar (Enter navigates; a bare host gets https), new tab; with several tabs, a tab strip to switch and close them |
| A page opens alert / confirm / prompt | It appears in the pane with OK / Cancel |
| Opening it by hand | "Browser preview" on the right sidebar's guide page (the blue globe, in the same style as "Workspace files" and "New terminal") |
| Language | Follows dsh's language setting: "浏览器预览" in Chinese, "Browser preview" in English; dsh's "follow system" option tracks the system language |
| Coming back after the workspace slept | The browser's cookies, sign-ins, and history are still there |

The agent has browser tools in every session, named `mcp__browser__*` (e.g. `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`).

## Enabling it

1. Admin console → **Plugins & MCP** → **添加工作空间浏览器 (add workspace browser)**. The template fills in kind "dsh plugin" and spec `file:/usr/local/lib/dsh-cloud/workspace-browser`.
2. In the same form, tick the **groups** to enable it for (or assign it to individual users later under Users). Unassigned entries are flagged in red in the list, "未分配，不会生效" (unassigned, not in effect).
3. Save, and **restart** the affected workspaces when prompted, or let users pick it up at their next sign-in.

Prerequisites: workspace images built from this project's base image (`sandbox-image/base`), which already contains Chromium, the browser hub, `@playwright/mcp`, and this plugin, so **enabling it needs no network**; and a gateway version that includes this feature (the relay route and port 3081).

## Architecture

```
User's browser (dsh Web page)
 ├─ right-sidebar "Browser preview" ─ WS /u/<user>/_dsh-cloud/browser ──────────┐
 └─ page-level watch connection ───── WS /u/<user>/_dsh-cloud/browser?watch=1 ──┤
                                                                                 ▼
Gateway (FastAPI): checks the session belongs to that user, relays to the sandbox's port 3081
                                                                                 ▼
Sandbox (one container per user)
 ├─ browser hub (Node)
 │    ├─ :3081          for the user: frames, tabs, input, dialogs (a small custom protocol)
 │    ├─ 127.0.0.1:9223 for the agent: a pass-through CDP proxy that also records agent activity
 │    └─ manages Chromium: started on first use, headless, debugging on 127.0.0.1:9222
 ├─ Chromium (profile in ~/.config/dsh-workspace-browser, saved with the workspace)
 └─ dsh
      ├─ dsh-mcp-client row: playwright-mcp --cdp-endpoint http://127.0.0.1:9223
      └─ client plugin dsh-cloud-workspace-browser: right-sidebar tab + auto-open
```

The agent and the user are connected to **the same Chromium**, so the user sees exactly the page the agent is working on, and the agent sees the user's changes on its next step.

## How each part works

### Browser hub (`sandbox-image/base/browser-hub/hub.mjs`)

- **Chromium lifecycle**: started only when the agent or a user first connects; idle, it is one small Node process. Before starting it removes leftover locks such as `SingletonLock` from the profile (a workspace restored from a snapshot carries the old container's locks, which make Chromium refuse to start). Flags include `--headless=new`, `--disable-dev-shm-usage` (containers get a 64 MB /dev/shm), `--window-size=1280,800`, and `--lang=zh-CN`. Chromium cannot create its own process sandbox inside a container, so the image adds `--no-sandbox` by default through `/etc/chromium.d/dsh-cloud`; the container is the isolation boundary.
- **Agent endpoint (127.0.0.1:9223)**: passes `/json/*` and WebSocket CDP traffic through, rewriting 9222 to 9223 in responses. Every CDP message from the agent counts as activity; 3 seconds without one counts as stopped, and both are broadcast to watchers.
- **User endpoint (:3081)**: does not expose raw CDP, only a set of JSON messages:

  | Direction | Messages |
  |---|---|
  | hub → pane | `frame` (JPEG from `Page.startScreencast`), `tabs` (tab list, can go back/forward), `agent` (operating or not), `dialog` / `dialog-closed`, `status` (starting / ready / error) |
  | pane → hub | `mouse` (down, up, move, wheel), `key` (special keys and shortcuts), `text` (typing, paste, input-method output, via `Input.insertText`), `navigate` / `back` / `forward` / `reload`, `activate` / `new-tab` / `close-tab`, `dialog` (accept / dismiss) |

  All panes share one CDP connection; when the last pane closes, screencasting stops. When the agent opens a new tab, the view switches to it.
- **Watch connections (`?watch=1`)**: receive only `agent` events, start no Chromium, and carry no frames; dsh pages use one to know when to open the pane.

### Entrypoint (`sandbox-image/base/entrypoint.sh`)

Starts the hub and dsh and acts as a small supervisor: on a stop signal it forwards it to both and waits for them, so Chromium flushes cookies and other data before the user's home is archived. Sleeping took about 2 seconds in testing.

### Gateway (`gateway/dsh_gateway/app.py`, `proxy.py`)

- Route `/u/<user>/_dsh-cloud/browser`, registered before the generic dsh relay route.
- Only that user's valid session may connect: another user gets close code 4401; a workspace without a hub (for example a container created by an older gateway) gets 4404.
- The query string (`?watch=1`) is passed through, and operating the pane counts as workspace activity.
- The Docker backend publishes the container's port 3081 on the host's `127.0.0.1`, like dsh's 3080, so it is not reachable from outside.

### dsh bundle and client plugin (`sandbox-image/base/workspace-browser/`)

| File | Role |
|---|---|
| `package.json` | Declares both `dsh.bundle` (a bundle with its own patch file) and `dsh.client` (a browser-side plugin that injects the right sidebar) |
| `cordis.patch.yml` | Inserts two rows: `@deepseek-ai/dsh-mcp-client` (`serverName: browser`, running the image's `playwright-mcp --cdp-endpoint http://127.0.0.1:9223 --image-responses omit`) and the plugin itself |
| `index.js` | Host face, empty; it exists so dsh's client module table serves `client.js` |
| `client.js` | The browser-side plugin, written directly in dsh's client module format (`window.__ModuleLoader__.load({ id, factory(require) })`); React and dsh's icons come from dsh's shared module table, so no build step is needed |

`client.js`:

- registers Chinese and English copy with `ctx.locale.register`, following dsh's language setting;
- registers the tab type and guide entry with `ctx.sidebarRightTabs.register` (icon `GuideArtworkBrowser`);
- registers the pane body in the `sidebar.right.pane.tab` slot and the chip title (`IconGlobeOutlineRegular` + name) in `sidebar.right.pane.tab.title`. The title text keeps 16px clear on its right and ends with an ellipsis, because the chip's label box runs about 14px under the close button;
- keeps a watch connection and calls `ctx.sidebarRight.openTab('workspace-browser')` to open or focus the pane when the agent starts operating;
- styles the pane like dsh's own Files and Terminal panes: no fill of its own, a spaced header, one hairline between the header and the view, a padded view with rounded corners.

### Provisioning (`sandbox-image/base/provision.py`)

Bundles shipped in the image as `file:` are installed, updated, or reinstalled **before dsh starts**, without network, so dsh boots with the right composition:

| Case | Handling |
|---|---|
| First assignment | `dsh plugin add file:…` and add it to the bundle list |
| The image's plugin version changed, dependencies did not | Copy the image's files over the installed copy (replacing files rather than writing in place, because installed files are hard links into the pnpm content store) |
| Dependencies changed | `dsh plugin remove`, then install again |

In the provisioning record `~/.dsh-cloud/provisioned.json`, `file:` entries carry their version (e.g. `file:/usr/local/lib/dsh-cloud/workspace-browser#0.4.3`), and a version change triggers the update above. Ordinary plugins downloaded from npm still install in the background after dsh starts.

## Data and security

| Data | Location | Saved? |
|---|---|---|
| Browser cookies, sign-ins, history, local storage | `/home/agent/.config/dsh-workspace-browser` | ✅ With the workspace snapshot; still there after sleep and resume |
| The installed copy of the plugin | `/home/agent/.dsh/profiles/web/node_modules/dsh-cloud-workspace-browser` | ✅ |
| Playwright MCP output files | `/tmp/playwright-mcp` | ❌ |

- The browser's debugging port (9222) and the agent endpoint (9223) listen only on `127.0.0.1` inside the sandbox.
- The user endpoint (3081) is published only on the gateway host's `127.0.0.1`, and the gateway checks that the session belongs to that user.
- Users see and operate only the browser in their own workspace. Accounts signed in to in that browser are part of the user's workspace data and are saved with the snapshot like everything else; in production, store them encrypted as part of the [persistent volume plan](../README.md#before-launch-one-persistent-volume-per-user).

## Upgrades and versions

- After changing files in `workspace-browser/`, **bump the version in its `package.json`** and rebuild the image. Users get the update the next time their workspace starts.
- Changes to the hub (`browser-hub/`) only need an image rebuild; it is part of the image.
- Gateway changes need a gateway restart; workspaces created by an older gateway, without port 3081 published, are recreated on the new code after one restart.
- `client.js` relies on dsh's pre-stable interfaces: `sidebarRightTabs`, the `sidebar.right.pane.tab(.title)` slots, `locale`, the icon names in the shared module `@deepseek-ai/dsh-client-ui-primitives`, and the client module format. **Re-verify after upgrading dsh.** Verified with `@deepseek-ai/dsh@0.2.1-rc.2`.

## Known limitations

- **Page content only**: the browser's own UI (address bar, tab strip, download bar, extension popups, file pickers and other native dialogs) is not shown; the pane draws its own address bar and tab strip. For a full desktop, noVNC can be added alongside.
- **No mutual exclusion**: the user and the agent can act at the same time; the pane signals "Agent is operating" but cannot pause the agent.
- **No screenshots to the model**: `--image-responses omit`, because the default DeepSeek models read text; page structure still arrives as a text snapshot. Drop the flag for a model that reads images.
- **Copy**: pasting into the page works, but text selected in the page cannot be copied to the local clipboard.
- **View**: JPEG frames, at a lower rate on slow networks, scaled to fit the pane.
- **Browser size** is fixed at 1280×800.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The pane keeps saying "Disconnected, reconnecting…" | The gateway is an older version without the browser relay route. Restart the gateway |
| The pane says "This workspace has no browser yet" | The workspace was created by an older gateway and has no port 3081 published. Sign out and back in, or restart the workspace from the admin console |
| No "Browser preview" in the right sidebar | The plugin is not assigned to this user or their group (flagged in red in the plugin list), or the workspace has not restarted since |
| The agent says it has no browser tools | Same as above; or the install before dsh's start failed: check `docker logs <container> \| grep provision` |
| The view is blank | The browser just started and is still on `about:blank`; enter a URL, or let the agent open a page |
| "Content Exists Risk" | DeepSeek's API content moderation refused the request (possibly triggered by page content), not this feature; retry in a new session, or use another source |

## Verification

Verified end to end on local Docker (OrbStack):

- the agent used `mcp__browser__*` to open Wikipedia, type into the search box, and open the result; the pane followed live with "Agent is operating";
- with the right sidebar collapsed, the pane opened by itself as soon as the agent started using the browser;
- with other sessions present, a new session still had the browser tools;
- clicking the search box in the pane, typing Chinese "深度求索", and pressing Enter navigated correctly;
- sleeping took about 2 seconds, with cookies and history in the snapshot of the user's home;
- several plugin upgrades, from 0.1 to 0.4.3, were applied automatically before dsh started;
- switching dsh between Chinese and English changed the pane's name, guide entry, and toolbar text; the chip title no longer runs under the close button.

## Design decisions

- **CDP screencasting rather than noVNC**: only the browser needs to be visible, not a desktop; CDP needs no virtual display, costs little, renders crisply, sends Chinese input as text (avoiding VNC's input-method problems), and connects to the very browser the agent uses.
- **Playwright MCP as an ordinary MCP server rather than dsh's experimental browser plugin**: dsh's `dsh-experimental-browser-use-playwright-mcp` in attach mode lets only one session hold the browser at a time, leaving later sessions without browser tools (reproduced in testing). An ordinary MCP server is visible to every session, and `@playwright/mcp` ships in the image, so enabling it needs no network.
- **The hub does not expose raw CDP to the browser side**: a small protocol is easier to control, and leaves room for permissions or auditing later.
- **A native right-sidebar tab rather than a page overlay**: it docks and goes fullscreen like dsh's own panes.
- **The bundle ships in the image and is provisioned as `file:`**: one catalog entry mounts both the MCP server and the pane, so admins assign a single entry.

## Files

```
sandbox-image/base/
├── Dockerfile                    installs Chromium, the hub, and @playwright/mcp; copies the plugin
├── entrypoint.sh                 starts the hub and dsh; forwards stop signals
├── provision.py                  installs and updates file: bundles before dsh starts
├── browser-hub/
│   ├── package.json              ws, @playwright/mcp
│   └── hub.mjs                   Chromium management, the agent CDP proxy, the user endpoint
└── workspace-browser/
    ├── package.json              dsh.bundle + dsh.client; the version decides updates
    ├── cordis.patch.yml          the Playwright MCP row + the plugin row
    ├── index.js                  host face (empty)
    └── client.js                 the right-sidebar "Browser preview"
gateway/dsh_gateway/
├── app.py                        the /u/<user>/_dsh-cloud/browser route
├── proxy.py                      relay_websocket
└── backends/docker_backend.py    publishes port 3081
web/src/pages/admin/Plugins.tsx   the "add workspace browser" template, group assignment
```
