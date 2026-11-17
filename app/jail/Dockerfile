# ─────────────────────────────────────────────────────────────────────────────
# ok-jail — the per-session sandbox image (PRD §6.4).
#
# Built and run ONLY when SESSION_ISOLATION=docker. Operator's live droplet leaves
# that flag unset, so nothing here is on the production path today.
#
# Deliberately does NOT inherit from app/Dockerfile: the control-plane image
# carries the docker CLI, root-owned paths and operator tooling, none of which
# may exist inside a jail. This file starts from a clean base for that reason.
#
# Build:  docker build -t ok-jail:local -f app/jail/Dockerfile app/jail
# Pin:    tag by digest and set SESSION_JAIL_IMAGE=ok-jail@sha256:… in any real
#         deployment. There is no registry push — publishing to ghcr.io is a
#         Operator-reserved open question (PRD §9), so the default tag is local.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# bash + tmux (session persistence lives INSIDE the jail — PRD §6.3),
# git + gh (the worker's only integration path is a PR),
# ca-certificates/curl for outbound HTTPS. Node comes from the base image.
# python3 (obj 901229): reviewers and workers run repo scripts and checks that
# shell out to python3; a review of PR 835 was blocked because the jail had
# none. It is in this BASE layer, so ok-jail:local and ok-jail-browser:local
# (the same file with WITH_BROWSER=1) both carry it.
#
# NOT installed, on purpose: docker.io / docker-ce-cli / containerd. A jail that
# can talk to a socket it should never see is not a jail; keeping the client out
# of the image is defence in depth behind "the socket is not mounted".
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      tmux \
      git \
      curl \
      ca-certificates \
      less \
      procps \
      python3 \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# The Claude CLI the session actually runs.
RUN npm install -g @anthropic-ai/claude-code tsx && npm cache clean --force

# ── Optional card browser (obj 901029) ────────────────────────────────────────
# OFF by default: the stock `ok-jail:local` image carries no Playwright, no
# Chromium and none of its shared libraries, so a card that did not ask for a
# browser cannot launch one even by downloading it (the libs are missing and
# the jail has no root to install them — exactly what card #901024 hit).
#
# A SEPARATE image is built for the cards that opt in (`needs_browser`):
#   docker build -t ok-jail-browser:local --build-arg WITH_BROWSER=1 \
#     -f app/jail/Dockerfile app/jail
# and the control plane selects it per card (SESSION_JAIL_BROWSER_IMAGE).
#
# PINNED. These ARGs must equal app/server/src/lib/browser-pins.ts AND the
# matching ARGs in app/Dockerfile; browser-pins.test.ts fails the gate if any
# of the three drift. Never `latest`.
#
# No setuid chrome_sandbox here, deliberately: the jail runs with
# `no-new-privileges`, which makes a setuid helper useless. Chromium's OS
# sandbox inside the jail is the user-namespace sandbox instead, which the
# control plane enables for browser jails ONLY, with the seccomp profile in
# app/server/src/lib/jail-browser-seccomp.json (Docker's default profile plus
# chroot/clone/unshare/setns — nothing else). If that is unavailable Chromium fails to
# launch; the launcher never falls back to --no-sandbox.
ARG WITH_BROWSER=0
ARG PLAYWRIGHT_VERSION=1.65.0
ARG PLAYWRIGHT_MCP_VERSION=0.0.85
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright
RUN if [ "$WITH_BROWSER" = "1" ]; then \
      npm install -g "playwright@${PLAYWRIGHT_VERSION}" "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
      && npx "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
      && chmod -R a+rX /usr/local/share/playwright \
      && npm cache clean --force \
      && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "ok-jail: built WITHOUT the card browser (WITH_BROWSER=$WITH_BROWSER)"; \
    fi

# Non-root jail user, UID >= 1000, no sudo, not in any docker group.
# The node base image already owns uid 1000, so jailuser takes 1001 and the
# control plane passes --user explicitly (SESSION_JAIL_USER / default 1000:1000
# is overridable per deployment).
RUN groupadd --gid 1001 jailuser \
    && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash jailuser \
    && mkdir -p /workspace && chown jailuser:jailuser /workspace

# Assert at build time that python3 is on PATH (obj 901229) — a jail image
# without it fails the build instead of failing a review later.
RUN python3 --version

# Assert at build time that no docker client leaked in via a transitive dep.
RUN if command -v docker >/dev/null 2>&1; then echo "FATAL: docker CLI present in jail image" >&2; exit 1; fi

USER jailuser
WORKDIR /workspace

# The control plane passes an explicit command (tmux new-session + a wait loop).
# This default keeps a hand-run container alive for inspection.
CMD ["bash", "-lc", "sleep infinity"]
