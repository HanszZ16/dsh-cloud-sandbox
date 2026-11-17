ARG BASE_IMAGE=dsh-sandbox:dev
FROM ${BASE_IMAGE}

USER root
ARG DEMO_CA_BASE64
# Trust the Mac-verified OrbStack CA for the fake site only. Regular images
# and every other hostname retain their existing certificate checks.
RUN test -n "$DEMO_CA_BASE64" \
 && mkdir -p /etc/chromium/policies/managed \
 && printf '{"CACertificatesWithConstraints":[{"certificate":"%s","constraints":{"permitted_dns_names":["dsh-signin-fixture.local"]}}]}\n' \
   "$DEMO_CA_BASE64" > /etc/chromium/policies/managed/dsh-demo-login.json
USER agent

# Reuse the installed DSH and browsers; add just the code under test.
COPY plugins/website-login /usr/local/lib/dsh-cloud/plugins/website-login
COPY browser-hub/hub.mjs /usr/local/lib/dsh-cloud/browser-hub/hub.mjs
