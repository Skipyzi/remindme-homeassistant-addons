# A thin wrapper over the official image. The only additions are a settings
# file generated from the add-on's options and a secret key persisted in
# /data — everything else is upstream SearXNG.
FROM ghcr.io/searxng/searxng:latest

# The upstream image runs as the searxng user; the add-on writes settings
# into /etc/searxng and reads /data, so it needs to start as root. The
# upstream entrypoint drops back down after preparing the volumes.
USER root

COPY gen-settings.py /gen-settings.py
COPY run.sh /run.sh
# The custom landing page and its assets. run.sh copies these over the
# installed theme on every start, so they follow wherever upstream keeps it.
COPY frontend /remindme-frontend
RUN chmod 0755 /run.sh /gen-settings.py && chmod -R a+rX /remindme-frontend

EXPOSE 8080
ENTRYPOINT ["/run.sh"]
