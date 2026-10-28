FROM node:22-alpine
# `script` gives the CLI sign-in consoles a terminal.
RUN apk add --no-cache util-linux

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
# The agent CLIs fetch their platform binaries in install hooks, run here explicitly.
RUN node node_modules/@anthropic-ai/claude-code/install.cjs
RUN node node_modules/opencode-ai/postinstall.mjs
COPY src ./src
RUN pnpm build
COPY public ./public

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/run.sh"]
