FROM node:22-alpine
# `script` gives the CLI sign-in consoles a terminal.
RUN apk add --no-cache util-linux

# A headless Chromium for the browse tool. It runs as its own unprivileged user
# through this wrapper, with a clean environment: a page that broke out of the
# renderer finds no tokens or keys, and /data is closed to it (run.sh).
RUN apk add --no-cache chromium su-exec font-dejavu \
	&& adduser -D -H -h /var/lib/remindme-browser -s /sbin/nologin browser \
	&& mkdir -p /var/lib/remindme-browser/profile \
	&& chown -R browser:browser /var/lib/remindme-browser \
	&& printf '#!/bin/sh\nexec /sbin/su-exec browser /usr/bin/chromium-browser "$@"\n' > /usr/local/bin/remindme-chromium \
	&& chmod 755 /usr/local/bin/remindme-chromium

# Tailscale for the phone app, pinned and checked: RemindMe joins the tailnet as its own device.
ARG TAILSCALE_VERSION=1.104.4
ARG TAILSCALE_SHA256=a1c249ce6bdebef62e1ae3b997595555bce2ae4709bf95a718e9ca7a129dad7e
RUN wget -qO /tmp/tailscale.tgz "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_arm64.tgz" \
	&& echo "${TAILSCALE_SHA256}  /tmp/tailscale.tgz" | sha256sum -c - \
	&& tar -xzf /tmp/tailscale.tgz -C /tmp \
	&& mv "/tmp/tailscale_${TAILSCALE_VERSION}_arm64/tailscale" "/tmp/tailscale_${TAILSCALE_VERSION}_arm64/tailscaled" /usr/local/bin/ \
	&& rm -rf /tmp/tailscale.tgz "/tmp/tailscale_${TAILSCALE_VERSION}_arm64"

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false --ignore-scripts
# Claude Code fetches its platform binary in an install hook, run here explicitly.
RUN node node_modules/@anthropic-ai/claude-code/install.cjs
COPY src ./src
RUN pnpm build
COPY public ./public

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/run.sh"]
