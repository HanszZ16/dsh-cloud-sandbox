# Per-user sandbox image: one dsh Web instance plus the user's workspace.
FROM node:22-bookworm-slim

ARG DSH_VERSION=0.2.1-rc.2
# dsh's plugin manager runs pnpm in the profile directory; without it neither
# the Web Plugins page nor gateway-assigned default plugins can install.
ARG PNPM_VERSION=11.28.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 python3-pip curl procps iproute2 \
 && rm -rf /var/lib/apt/lists/*
# Proxy build args (http_proxy/https_proxy) are honored by apt and npm but not persisted.
RUN npm config set fetch-retries 5 \
 && npm install -g @deepseek-ai/dsh@${DSH_VERSION} pnpm@${PNPM_VERSION} \
 && npm cache clean --force

COPY entrypoint.sh /usr/local/bin/dsh-sandbox-entrypoint
COPY provision.py /usr/local/lib/dsh-cloud/provision.py
# The pnpm content store lives outside /home/agent: installed plugins are
# persisted through their node_modules copies, not through the cache.
RUN chmod +x /usr/local/bin/dsh-sandbox-entrypoint \
 && useradd -m -u 1001 agent \
 && mkdir -p /var/cache/pnpm-store /etc/dsh-cloud \
 && chown agent:agent /var/cache/pnpm-store

# /home/agent is the user's whole computer: dsh state, projects, user-level
# packages, and dotfiles. The gateway persists exactly this directory.
USER agent
ENV DSH_HOME=/home/agent/.dsh \
    pnpm_config_store_dir=/var/cache/pnpm-store \
    pnpm_config_cache_dir=/var/cache/pnpm-store/cache \
    NPM_CONFIG_PREFIX=/home/agent/.local \
    PATH=/home/agent/.local/bin:$PATH
WORKDIR /home/agent
EXPOSE 3080
ENTRYPOINT ["dsh-sandbox-entrypoint"]
