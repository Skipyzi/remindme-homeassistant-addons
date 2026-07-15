FROM ghcr.io/ggml-org/llama.cpp:server

COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 8080
ENTRYPOINT ["/run.sh"]
