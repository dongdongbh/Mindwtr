FROM oven/bun:1.3.3-alpine AS base
WORKDIR /app
RUN mkdir -p /app/cloud_data

FROM base AS cloud
RUN apk add --no-cache curl
RUN apk add --no-cache python3 make g++
ENV CXXFLAGS="-std=c++20"
ENV npm_config_cxxstd=gnu++20
ENV npm_config_target="22.21.1"
ENV npm_config_disturl="https://nodejs.org/dist"

ENV MINDWTR_CLOUD_DATA_DIR=/app/cloud_data

COPY --chown=1000:1000 . .
RUN chown bun:bun /app
USER bun
RUN bun install

EXPOSE 8787/tcp
HEALTHCHECK --interval=1m30s --timeout=10s --start-period=30s --retries=3 CMD curl -fsS http://localhost:8787/health >/dev/null || exit 1
ENTRYPOINT ["bun", "run", "--filter", "mindwtr-cloud", "start", "--", "--host", "0.0.0.0", "--port", "8787"]
