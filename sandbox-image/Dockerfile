# Per-user sandbox image: one dsh Web instance plus the user's workspace.
FROM node:22-bookworm-slim

ARG DSH_VERSION=0.2.1-rc.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 python3-pip curl procps iproute2 \
 && rm -rf /var/lib/apt/lists/*
# Proxy build args (http_proxy/https_proxy) are honored by apt and npm but not persisted.
RUN npm config set fetch-retries 5 \
 && npm install -g @deepseek-ai/dsh@${DSH_VERSION} \
 && npm cache clean --force

COPY entrypoint.sh /usr/local/bin/dsh-sandbox-entrypoint
RUN chmod +x /usr/local/bin/dsh-sandbox-entrypoint \
 && useradd -m -u 1001 agent

# /home/agent is the user's whole computer: dsh state, projects, user-level
# packages, and dotfiles. The gateway persists exactly this directory.
USER agent
ENV DSH_HOME=/home/agent/.dsh
WORKDIR /home/agent
EXPOSE 3080
ENTRYPOINT ["dsh-sandbox-entrypoint"]
