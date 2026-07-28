ARG BUILD_FROM=node:22-alpine
FROM ${BUILD_FROM} AS build
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM ${BUILD_FROM}
WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY public ./public
COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
