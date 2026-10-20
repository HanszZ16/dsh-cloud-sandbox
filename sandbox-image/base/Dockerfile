# Base workspace image: one dsh Web instance plus the user's workspace.
# Team images in ../variants build FROM this image and only add software; the
# gateway relies on everything defined here (user, paths, entrypoint, port).
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

ARG DSH_VERSION=0.2.1-rc.2
# dsh's plugin manager runs pnpm in the profile directory; without it neither
# the Web Plugins page nor gateway-assigned default plugins can install.
ARG PNPM_VERSION=11.28.5
# Optional Debian mirror host (e.g. mirrors.ustc.edu.cn) for networks where
# deb.debian.org is slow or unreachable; empty keeps the official mirror.
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
      echo 'Acquire::http::Proxy "DIRECT"; Acquire::https::Proxy "DIRECT";' > /etc/apt/apt.conf.d/81-mirror-direct; \
    fi \
 && echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 python3-pip curl procps iproute2 \
 && rm -rf /var/lib/apt/lists/*
# Software every workspace shares. System directories reset on every start and
# users are not root, so tools that need system libraries belong here, not in
# the user's home: Chromium for browser automation, python3-venv so users can
# keep their own Python environments under /home/agent, headless LibreOffice
# for document conversion, and CJK fonts so Chinese renders in both.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium fonts-noto-cjk fonts-liberation \
      python3-venv \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
 && rm -rf /var/lib/apt/lists/*
# Proxy build args (http_proxy/https_proxy) are honored by apt and npm but not persisted.
RUN npm config set fetch-retries 5 \
 && npm install -g @deepseek-ai/dsh@${DSH_VERSION} pnpm@${PNPM_VERSION} \
 && npm cache clean --force

COPY browser-hub/package.json /usr/local/lib/dsh-cloud/browser-hub/package.json
RUN cd /usr/local/lib/dsh-cloud/browser-hub \
 && npm install --omit=dev --no-fund --no-audit \
 && npm cache clean --force
COPY browser-hub/hub.mjs /usr/local/lib/dsh-cloud/browser-hub/hub.mjs
# The workspace browser dsh bundle; admins provision it to groups with the
# spec file:/usr/local/lib/dsh-cloud/workspace-browser. Its dsh packages are
# pinned to this image's dsh version.
COPY workspace-browser /usr/local/lib/dsh-cloud/workspace-browser
RUN sed -i "s/__DSH_VERSION__/${DSH_VERSION}/g" /usr/local/lib/dsh-cloud/workspace-browser/package.json
COPY entrypoint.sh /usr/local/bin/dsh-sandbox-entrypoint
COPY provision.py /usr/local/lib/dsh-cloud/provision.py
# The pnpm content store lives outside /home/agent: installed plugins are
# persisted through their node_modules copies, not through the cache.
# Chromium cannot create its own process sandbox inside a container; the
# container is the isolation boundary, so every launch through /usr/bin/chromium
# (Puppeteer, browser MCP servers, dsh's browser plugins) gets --no-sandbox.
RUN chmod +x /usr/local/bin/dsh-sandbox-entrypoint \
 && useradd -m -u 1001 agent \
 && mkdir -p /var/cache/pnpm-store /etc/dsh-cloud \
 && chown agent:agent /var/cache/pnpm-store \
 && echo 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox"' > /etc/chromium.d/dsh-cloud

# /home/agent is the user's whole computer: dsh state, projects, user-level
# packages, and dotfiles. The gateway persists exactly this directory.
USER agent
ENV DSH_HOME=/home/agent/.dsh \
    pnpm_config_store_dir=/var/cache/pnpm-store \
    pnpm_config_cache_dir=/var/cache/pnpm-store/cache \
    NPM_CONFIG_PREFIX=/home/agent/.local \
    PATH=/home/agent/.local/bin:$PATH \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=1
WORKDIR /home/agent
# 3080: dsh Web. 3081: workspace browser hub (live view), forwarded by the gateway.
EXPOSE 3080 3081
ENTRYPOINT ["dsh-sandbox-entrypoint"]
# Compatibility labels, inherited by every team image. A user's home moves
# between images of one group change, so the gateway only accepts images
# whose dsh version and runtime (Node, Debian release, hence Python) match
# the default image's: sessions, installed plugins, and venvs stay usable.
# NODE_IMAGE is re-declared only here so it does not invalidate earlier layers.
ARG NODE_IMAGE
LABEL dsh-cloud.contract="1" \
      dsh-cloud.dsh-version="${DSH_VERSION}" \
      dsh-cloud.runtime="${NODE_IMAGE}"
