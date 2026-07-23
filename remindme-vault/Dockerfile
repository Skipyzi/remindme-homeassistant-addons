FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json build-frontend.mjs ./
COPY src ./src
COPY frontend ./frontend
COPY public ./public
# Compiles the server (tsc → dist/) and bundles the frontend (esbuild →
# public/bundle.js). The image needs the toolchain only at build time.
RUN npm run build

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/run.sh"]
