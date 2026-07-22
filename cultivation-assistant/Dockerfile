# syntax=docker/dockerfile:1.7

ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-python:3.12-alpine3.21

FROM node:22-alpine AS frontend-builder
WORKDIR /source
RUN corepack enable
COPY app/package.json app/pnpm-lock.yaml app/pnpm-workspace.yaml ./
COPY app/frontend/package.json frontend/package.json
RUN pnpm install --frozen-lockfile
COPY app/frontend frontend
RUN pnpm --filter cultivation-assistant-frontend build

FROM ${BUILD_FROM}

COPY --from=ghcr.io/astral-sh/uv:0.11.21 /uv /usr/local/bin/uv
WORKDIR /app

COPY app/pyproject.toml app/uv.lock ./
COPY app/backend backend
RUN uv sync --frozen --no-dev --no-editable

COPY --from=frontend-builder /source/frontend/dist /app/frontend
COPY rootfs /
RUN chmod +x \
    /etc/services.d/cultivation/run \
    /etc/services.d/cultivation/finish

ENV PATH="/app/.venv/bin:${PATH}" \
    CULTIVATION_DATA_DIR="/data" \
    CULTIVATION_FRONTEND_DIST="/app/frontend" \
    PYTHONUNBUFFERED="1"

EXPOSE 8099
