# syntax=docker/dockerfile:1
ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.21
ARG GO_VERSION=1.26

# ---------------------------------------------------------------------------
# Stage 1 - controller binary (pure Go, no cgo, cross-compiles to arm64)
# ---------------------------------------------------------------------------
FROM golang:${GO_VERSION}-alpine AS backend
ARG BUILD_ARCH=aarch64
ARG BUILD_VERSION=dev
ENV CGO_ENABLED=0 GOOS=linux
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN set -eu; \
    case "${BUILD_ARCH}" in \
      aarch64) export GOARCH=arm64 ;; \
      amd64)   export GOARCH=amd64 ;; \
      armv7)   export GOARCH=arm GOARM=7 ;; \
      *) echo "unsupported BUILD_ARCH=${BUILD_ARCH}" >&2; exit 1 ;; \
    esac; \
    go build -trimpath -ldflags "-s -w -X main.buildVersion=${BUILD_VERSION}" \
      -o /out/mc-controller ./cmd/controller; \
    go vet ./... || true

# ---------------------------------------------------------------------------
# Stage 2 - mcbridge Paper plugin (telemetry over a Unix socket)
# ---------------------------------------------------------------------------
FROM maven:3.9-eclipse-temurin-21 AS plugin
WORKDIR /src
COPY paper-plugin/ ./
RUN mvn -B -q -DskipTests package && \
    mkdir -p /out && cp target/mcbridge-*.jar /out/mcbridge.jar

# ---------------------------------------------------------------------------
# Stage 3 - runtime
# ---------------------------------------------------------------------------
FROM ${BUILD_FROM}

# Java 21 (Paper 1.20.5+ requirement), restic for deduplicated backups.
RUN apk add --no-cache \
      openjdk21-jre-headless \
      restic \
      ca-certificates \
      tzdata \
    && rm -rf /var/cache/apk/*

ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk \
    PATH="/usr/lib/jvm/java-21-openjdk/bin:${PATH}" \
    MC_DATA_DIR=/data \
    MC_FRONTEND_DIR=/opt/minecraft/frontend \
    MC_ASSETS_DIR=/opt/minecraft/assets \
    MC_LISTEN=0.0.0.0:8099 \
    LANG=C.UTF-8

COPY --from=backend /out/mc-controller /usr/bin/mc-controller
COPY --from=plugin  /out/mcbridge.jar  /opt/minecraft/assets/mcbridge.jar
COPY frontend/ /opt/minecraft/frontend/
COPY presets/  /opt/minecraft/assets/presets/
COPY rootfs/   /

RUN chmod +x /usr/bin/mc-controller \
    && chmod +x /etc/s6-overlay/s6-rc.d/controller/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/controller/finish

LABEL io.hass.type="addon" io.hass.arch="aarch64|amd64"
