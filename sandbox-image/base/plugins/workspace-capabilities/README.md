# Workspace capabilities (dsh-cloud built-in plugin)

Adds **Settings → MCP 与技能 (MCP & skills)** to dsh Web: the workspace's MCP servers and skills, read-only.

| File | Contents |
|---|---|
| `index.js` | Host face: `GET api/dshCloudCapabilities/overview`, which reports each MCP server (source, transport, masked command or URL, environment and header names, state, tools, recent log messages) and each skill (source, path, invocation) |
| `client.js` | Client face: the Settings section, reloaded every 5 seconds while shown, in Chinese and English |

## Where the data comes from

dsh's MCP client has no status API, so a server's state is derived:

| State | Condition |
|---|---|
| Disabled | The loader entry is disabled |
| Starting | The entry's plugin is pending or loading |
| Failed to start | The entry's plugin failed; its error is shown |
| Online · N tools | The plugin is active and tools named `mcp__<server>__*` are registered |
| No tools available | The plugin is active without tools: connecting, reconnecting, or given up after `reconnect.maxAttempts` failures |

Source: the entry id `dsh-cloud-browser-mcp` is built in (the remote browser), ids starting with `dsh-cloud-mcp-` are provisioned by the gateway's admin console (team), and every other row is the user's own (personal).

Recent log messages are the MCP client's messages labelled `mcp-client(<server>)` (connection failures, reconnects, giving up), errors to warnings, collected in memory by a logger exporter from this plugin's start: dsh Web prints them nowhere. Output a server process itself writes to stderr is not attributed to a server and is not shown. Skills are listed in the default agent preset's scope (dsh mounts skill providers per preset), cached for 30 seconds, for every distinct Session working directory and every project under `projectsDir` (at most `maxProjects` in all), so project skills show which projects they belong to.

Environment and header values are never returned; command arguments, URLs, errors, and log messages are masked where they look like secrets.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `logLines` | `5` | Recent log messages kept and shown per server; `0` turns collection off |
| `maxProjects` | `10` | Project directories whose project skills are listed: Session working directories first, then projects under `projectsDir` |
| `projectsDir` | `~/workspaces` | Where users' projects live |

## Pre-stable dependencies

The report reads dsh internals that may change between versions: loader entries (`ctx.loader.entries()`, `entry.options`, `entry.fiber.state`), `ctx.tools.definitions()`, `ctx.skills.list()`, `ctx.sessionPersistence.list()`, `ctx.agentPresets.acquireScope()`, `ctx.logger.exporter()`, the `settings.section` slot, and the MCP client's log label. A source that cannot be read is reported in the section as unavailable instead of failing it. Re-verify after upgrading dsh; verified with `@deepseek-ai/dsh@0.2.2-alpha.3`.

Bump `version` in `package.json` when changing this directory; provision re-links the plugin for users whose profile carries an older version.
