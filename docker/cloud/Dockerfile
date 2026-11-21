FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS base
WORKDIR /app

FROM base AS cloud-runtime
RUN apk add --no-cache curl su-exec
COPY docker/cloud/entrypoint.sh /usr/local/bin/mindwtr-cloud-entrypoint
USER bun
ENTRYPOINT ["/usr/local/bin/mindwtr-cloud-entrypoint"]

FROM base AS deps
RUN apk add --no-cache python3 make g++
ENV CXXFLAGS="-std=c++20"
ENV npm_config_cxxstd=gnu++20
ENV npm_config_target="22.21.1"
ENV npm_config_disturl="https://nodejs.org/dist"

COPY --chown=1000:1000 . .
RUN chown bun:bun /app
USER bun
RUN bun install --production --frozen-lockfile

FROM cloud-runtime AS cloud
USER root
ENV MINDWTR_CLOUD_DATA_DIR=/app/cloud_data
COPY --from=deps --chown=bun:bun /app /app
RUN mkdir -p /app/cloud_data && chown bun:bun /app/cloud_data
USER bun

EXPOSE 8787/tcp
HEALTHCHECK --interval=1m30s --timeout=10s --start-period=30s --retries=3 CMD curl -fsS http://localhost:8787/ready >/dev/null || exit 1
CMD ["bun", "run", "--filter", "mindwtr-cloud", "start", "--", "--host", "0.0.0.0", "--port", "8787"]
