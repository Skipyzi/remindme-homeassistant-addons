FROM golang:1.24-alpine AS manager-build

WORKDIR /src
COPY manager/go.mod ./
COPY manager/cmd ./cmd
COPY manager/internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/model-manager ./cmd/model-manager

FROM ghcr.io/ggml-org/llama.cpp:server@sha256:6bc9134e3278a0ecab23d7ef2f6a46b4595740014fe9bc2f67e8ba7dca8395b4

RUN mv /app/llama-server /app/llama-server.bin
COPY --from=manager-build /out/model-manager /app/model-manager
COPY manager/internal/catalog/catalog.json /app/catalog.json
COPY run.sh /run.sh
RUN chmod 0755 /run.sh /app/model-manager /app/llama-server.bin

EXPOSE 8080
ENTRYPOINT ["/run.sh"]
