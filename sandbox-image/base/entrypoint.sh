#!/bin/sh
# Starts the workspace: dsh Web bound to this sandbox's own interface address,
# plus the workspace browser hub.
# Required env: DSH_PUBLIC_URL, DSH_TRUSTED_HOST. dsh rejects wildcard binds,
# so the listeners bind the first concrete IPv4 address of this sandbox.
# The gateway may place /etc/dsh-cloud/policy.json (packages installed once per
# user: MCP server packages before dsh starts, plugin bundles in the background
# after dsh listens) and /etc/dsh-cloud/admin.cordis.yml (an overlay applied on
# every start). Run the container with an init process (docker --init) so
# background helpers are reaped.
set -eu
: "${DSH_PUBLIC_URL:?}" "${DSH_TRUSTED_HOST:?}"
BIND_IP="${DSH_BIND_IP:-$(hostname -I | awk '{print $1}')}"
PORT="${DSH_PORT:-3080}"
python3 /usr/local/lib/dsh-cloud/provision.py npm || true

# The hub starts Chromium only on first use; idle it costs one small Node process.
HUB_HOST="$BIND_IP" HUB_PORT="${HUB_PORT:-3081}" node /usr/local/lib/dsh-cloud/browser-hub/hub.mjs &
HUB_PID=$!
python3 /usr/local/lib/dsh-cloud/provision.py bundles "$BIND_IP" "$PORT" &

# --patch is a launcher option: it must precede the web app's own flags.
set -- --profile web
if [ -f /etc/dsh-cloud/admin.cordis.yml ]; then
  set -- "$@" --patch /etc/dsh-cloud/admin.cordis.yml
fi
dsh "$@" --no-open \
  --host "$BIND_IP" --port "$PORT" \
  --public-url "$DSH_PUBLIC_URL" --trusted-host "$DSH_TRUSTED_HOST" &
DSH_PID=$!

# The init process signals only this shell, so forward stop signals to both
# children and wait: dsh closes its stores and Chromium flushes its profile
# before the gateway copies /home/agent.
stop() {
  kill -TERM "$DSH_PID" "$HUB_PID" 2>/dev/null || true
  wait "$DSH_PID" 2>/dev/null || true
  wait "$HUB_PID" 2>/dev/null || true
  exit 0
}
trap stop TERM INT
wait "$DSH_PID"
