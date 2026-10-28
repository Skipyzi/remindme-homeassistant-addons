FROM node:22-alpine
# `script` gives the CLI sign-in consoles a terminal.
RUN apk add --no-cache util-linux

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
