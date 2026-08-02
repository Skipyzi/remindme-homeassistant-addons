# syntax=docker/dockerfile:1
ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.23
ARG GO_VERSION=1.26

# ---------------------------------------------------------------------------
# Stage 1 - controller binary (pure Go, no cgo, cross-compiles to arm64)
#
# Pinned to the build host's own platform: the controller is cross-compiled with
# GOARCH below, which is minutes faster than compiling under qemu emulation and
# produces the same binary.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS backend
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
#
# Also pinned to the build host: the output is architecture-independent Java
# bytecode, so there is nothing to gain from emulating the target.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM maven:3.9-eclipse-temurin-21 AS plugin
WORKDIR /src
COPY paper-plugin/ ./
RUN mvn -B -q -DskipTests package && \
    mkdir -p /out && cp target/mcbridge-*.jar /out/mcbridge.jar

# ---------------------------------------------------------------------------
# Stage 3 - runtime
# ---------------------------------------------------------------------------
FROM ${BUILD_FROM}

# Two JREs on purpose: Paper for the Minecraft 1.21 line runs on Java 21, while
# the 26.x releases declare java_version 25 in their version.json. The controller
# reads that field and launches the server with the matching runtime, so both old
# worlds and current versions work in the same image.
RUN apk add --no-cache \
      openjdk21-jre-headless \
      openjdk25-jre-headless \
      restic \
      ca-certificates \
      tzdata \
    && rm -rf /var/cache/apk/*

# The add-on container runs as root, and so would the Minecraft server, which
# every server warns about at startup - with reason: a plugin, a mod or a world
# exploit would run with full container privileges. The controller keeps root
# (it owns /data and signals the JVM) and launches the server as this user.
RUN addgroup -g 1000 minecraft \
    && adduser -u 1000 -G minecraft -D -H -s /sbin/nologin minecraft

# PATH points at Java 21 only as a default for anything that shells out to "java";
# the controller always selects the runtime explicitly.
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk \
    PATH="/usr/lib/jvm/java-21-openjdk/bin:${PATH}" \
    MC_DATA_DIR=/data \
    MC_FRONTEND_DIR=/opt/minecraft/frontend \
    MC_ASSETS_DIR=/opt/minecraft/assets \
    MC_LISTEN=0.0.0.0:8099 \
    MC_SERVER_UID=1000 \
    MC_SERVER_GID=1000 \
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
