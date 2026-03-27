FROM oven/bun:1.3.3-alpine AS base
WORKDIR /app

RUN apk add --no-cache python3 make g++
ENV CXXFLAGS="-std=c++20"
ENV npm_config_cxxstd=gnu++20
ENV npm_config_target="22.21.1"
ENV npm_config_disturl="https://nodejs.org/dist"

COPY --chown=1000:1000 . .
RUN chown bun:bun /app
USER bun
RUN bun install
RUN bun desktop:web:build

FROM nginx:alpine AS web
EXPOSE 5173/tcp
COPY --from=base /app/apps/desktop/dist /usr/share/nginx/html
COPY docker/app/nginx.conf /etc/nginx/conf.d/default.conf
