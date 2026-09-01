FROM oven/bun:1.3.5-alpine@sha256:7156fcc0cee0194d390bfaf7f0eeda9a5e383e70cc90f31aad3a2440a033d7dc AS base
WORKDIR /app

RUN apk add --no-cache python3 make g++
ENV CXXFLAGS="-std=c++20"
ENV npm_config_cxxstd=gnu++20
ENV npm_config_target="22.21.1"
ENV npm_config_disturl="https://nodejs.org/dist"

COPY --chown=1000:1000 . .
RUN chown bun:bun /app
USER bun
RUN bun install --frozen-lockfile
ARG VITE_RELEASE_VERSION=""
RUN VITE_RELEASE_VERSION="$VITE_RELEASE_VERSION" bun desktop:web:build

FROM nginx:1.31.4-alpine@sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913 AS web
RUN apk add --no-cache curl
EXPOSE 5173/tcp
HEALTHCHECK --interval=1m30s --timeout=10s --start-period=30s --retries=3 CMD curl -fsS http://localhost:5173/ >/dev/null || exit 1
COPY --from=base /app/apps/desktop/dist /usr/share/nginx/html
COPY docker/app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 docker/app/10-runtime-config.sh /docker-entrypoint.d/10-runtime-config.sh
