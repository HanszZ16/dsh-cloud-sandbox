#!/bin/sh
# Starts dsh Web bound to this sandbox's own interface address.
# Required env: DSH_PUBLIC_URL, DSH_TRUSTED_HOST. dsh rejects wildcard binds,
# so the listener binds the first concrete IPv4 address of this sandbox.
set -eu
: "${DSH_PUBLIC_URL:?}" "${DSH_TRUSTED_HOST:?}"
BIND_IP="${DSH_BIND_IP:-$(hostname -I | awk '{print $1}')}"
exec dsh --profile web --no-open \
  --host "$BIND_IP" --port "${DSH_PORT:-3080}" \
  --public-url "$DSH_PUBLIC_URL" --trusted-host "$DSH_TRUSTED_HOST"
