#!/bin/sh
# Start the gateway. Releasing sandboxes happens in the lifespan shutdown, which
# uvicorn runs only after open connections end; the graceful timeout bounds that
# wait so a browser holding a WebSocket cannot block teardown.
set -eu
cd "$(dirname "$0")"
# .env values override the calling shell, so a stale or empty export cannot win.
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi
if [ "${1:-}" = "--test-website-login" ]; then
  shift
  . ./dev/website-login/prepare.sh
fi
set -- uvicorn dsh_gateway.app:create_app --factory \
  --host "${GATEWAY_BIND:-127.0.0.1}" --port "${GATEWAY_PORT:-8000}" \
  --timeout-graceful-shutdown 10 "$@"
if [ -n "${WEBSITE_LOGIN_ORIGIN:-}" ]; then
  set -- --with-requirements requirements-website-login.txt "$@"
fi
exec uv run "$@"
