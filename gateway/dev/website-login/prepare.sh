# Sourced by gateway/run.sh, in gateway/ after its normal .env was loaded.
# Keep the backend, database, accounts and workspace storage from that file.
case "${GATEWAY_PUBLIC_URL:-http://localhost:8000}" in
  http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*) ;;
  *) printf '%s\n' 'The website sign-in demo requires a local HTTP gateway on this Mac.' >&2; exit 1 ;;
esac
if [ -n "${WEBSITE_LOGIN_ORIGIN:-}" ]; then
  printf '%s\n' 'Website sign-in is already configured. Start the gateway without --test-website-login.' >&2
  exit 1
fi

website_login_base_image="${SANDBOX_DOCKER_IMAGE:-dsh-sandbox:dev}"
if ! docker image inspect "$website_login_base_image" >/dev/null 2>&1; then
  printf 'Cannot access local image %s. Check that OrbStack is running and that your normal workspace image exists.\n' \
    "$website_login_base_image" >&2
  exit 1
fi
printf '%s\n' 'Preparing the local website sign-in test…'
uv run --with-requirements requirements-website-login.txt playwright install chromium

website_login_key="$PWD/data/website-login-local/vault-key"
(umask 077; mkdir -p "${website_login_key%/*}"; [ -s "$website_login_key" ] || openssl rand -hex 32 > "$website_login_key")
export WEBSITE_LOGIN_VAULT_KEY="$(cat "$website_login_key")"
export WEBSITE_LOGIN_ORIGIN=https://dsh-signin-vault.local WEBSITE_LOGIN_SITES_FILE="$PWD/dev/website-login/sites.json"
export SANDBOX_DOCKER_IMAGE=dsh-sandbox:website-login-demo GATEWAY_PUBLIC_URL=https://dsh-signin-web.local
export DSH_WEBSITE_LOGIN_GATEWAY_PORT="${GATEWAY_PORT:-8000}"
export GATEWAY_SANDBOX_CALLBACK_URL="http://host.docker.internal:$DSH_WEBSITE_LOGIN_GATEWAY_PORT"
docker compose -f dev/website-login/compose.yaml up -d
# Get the OrbStack CA from the HTTPS chain verified by the Mac. OrbStack
# presents separate leaf certificates to the Mac and its Linux containers.
website_login_certs=$(curl -q --noproxy '*' --retry 2 --retry-all-errors --retry-delay 1 \
  --max-time 12 -fsS --output /dev/null --write-out '%{certs}' https://dsh-signin-fixture.local/login)
website_login_ca=$(printf '%s\n' "$website_login_certs" | awk '/BEGIN CERTIFICATE/{p=""; on=1} on{p=p $0 "\n"} /END CERTIFICATE/{ca=p; on=0} END{printf "%s",ca}')
website_login_ca_subject=$(printf '%s\n' "$website_login_ca" | openssl x509 -noout -subject -nameopt RFC2253)
case "$website_login_ca_subject" in
  *'CN=OrbStack Development Root CA,'*) ;;
  *) printf '%s\n' 'The test site did not present the OrbStack HTTPS certificate chain.' >&2; exit 1 ;;
esac
website_login_ca_b64=$(printf '%s\n' "$website_login_ca" | sed '/-----/d' | tr -d '\n\r')
docker build -f dev/website-login/Dockerfile --build-arg "BASE_IMAGE=$website_login_base_image" \
  --build-arg "DEMO_CA_BASE64=$website_login_ca_b64" \
  -t dsh-sandbox:website-login-demo ../sandbox-image/base
export WEBSITE_LOGIN_LOCAL_DEMO=1
printf '\nDSH test: %s/admin\nSign in with your existing DSH account.\n\n' "$GATEWAY_PUBLIC_URL"
