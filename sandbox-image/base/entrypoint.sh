#!/bin/sh
# Starts dsh Web bound to this sandbox's own interface address.
# Required env: DSH_PUBLIC_URL, DSH_TRUSTED_HOST. dsh rejects wildcard binds,
# so the listener binds the first concrete IPv4 address of this sandbox.
# The gateway may place /etc/dsh-cloud/policy.json (packages installed once per
# user: MCP server packages before dsh starts, plugin bundles in the background
# after dsh listens) and /etc/dsh-cloud/admin.cordis.yml (an overlay applied on
# every start). Run the container with an init process
# (docker --init) so the background provisioner is reaped.
set -eu
: "${DSH_PUBLIC_URL:?}" "${DSH_TRUSTED_HOST:?}"
BIND_IP="${DSH_BIND_IP:-$(hostname -I | awk '{print $1}')}"
PORT="${DSH_PORT:-3080}"
python3 /usr/local/lib/dsh-cloud/provision.py npm || true
python3 /usr/local/lib/dsh-cloud/provision.py bundles "$BIND_IP" "$PORT" &
# --patch is a launcher option: it must precede the web app's own flags.
set -- --profile web
if [ -f /etc/dsh-cloud/admin.cordis.yml ]; then
  set -- "$@" --patch /etc/dsh-cloud/admin.cordis.yml
fi
exec dsh "$@" --no-open \
  --host "$BIND_IP" --port "$PORT" \
  --public-url "$DSH_PUBLIC_URL" --trusted-host "$DSH_TRUSTED_HOST"
