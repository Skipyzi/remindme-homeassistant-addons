FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1
WORKDIR /opt/rival
COPY requirements.txt ./
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt \
    && useradd --system --uid 10001 --home-dir /data rival
COPY rival/ ./rival/
COPY web/ ./web/
COPY THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY run.sh /run.sh
RUN chmod 0755 /run.sh
EXPOSE 8099
ENTRYPOINT ["/run.sh"]
