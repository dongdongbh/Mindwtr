FROM oven/bun:1.3.3-alpine@sha256:d2bc1fbc3afcd3d70afc2bb2544235bf559caae2a3084e9abed126e233797511 AS base
WORKDIR /app

FROM base AS deps
RUN apk add --no-cache python3 make g++
ENV CXXFLAGS="-std=c++20"
ENV npm_config_cxxstd=gnu++20
ENV npm_config_target="22.21.1"
ENV npm_config_disturl="https://nodejs.org/dist"

COPY --chown=1000:1000 . .
RUN chown bun:bun /app
USER bun
RUN bun install --production

FROM base AS cloud
RUN apk add --no-cache curl
ENV MINDWTR_CLOUD_DATA_DIR=/app/cloud_data
COPY --from=deps --chown=bun:bun /app /app
RUN mkdir -p /app/cloud_data && chown bun:bun /app/cloud_data
USER bun

EXPOSE 8787/tcp
HEALTHCHECK --interval=1m30s --timeout=10s --start-period=30s --retries=3 CMD curl -fsS http://localhost:8787/health >/dev/null || exit 1
ENTRYPOINT ["bun", "run", "--filter", "mindwtr-cloud", "start", "--", "--host", "0.0.0.0", "--port", "8787"]
