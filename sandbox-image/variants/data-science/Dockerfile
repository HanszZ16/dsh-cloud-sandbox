# Data-science workspace image: the base image plus Python data libraries.
# Debian's packages install into the system Python, so they work without a
# venv and stay compatible with venvs users create in their home.
ARG BASE_IMAGE=dsh-sandbox:dev
FROM ${BASE_IMAGE}
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3-numpy python3-pandas python3-scipy python3-matplotlib \
      python3-sklearn python3-openpyxl ipython3 \
 && rm -rf /var/lib/apt/lists/*
# Images must end as the agent user; the entrypoint, ports, and labels come from the base.
USER agent
