FROM node:22-alpine

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false --ignore-scripts
RUN node node_modules/@anthropic-ai/claude-code/install.cjs
RUN node node_modules/opencode-ai/postinstall.mjs
COPY src ./src
RUN pnpm build
COPY public ./public

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/run.sh"]
