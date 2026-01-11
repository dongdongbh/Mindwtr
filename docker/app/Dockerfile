# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1.3-alpine AS base
WORKDIR /app

RUN apk add --no-cache python3 make g++
ENV CXXFLAGS="-std=c++20"
ENV npm_config_cxxstd=gnu++20

COPY --chown=1000:1000 . .
RUN chown bun:bun /app
USER bun
RUN bun install
RUN bun desktop:web:build
# RUN chown bun:bun -R /app/apps/desktop

# Run the PWA
# EXPOSE 5173/tcp
# ENTRYPOINT ["bun", "desktop:web", "--host", "0.0.0.0", "--port", "5173"]

FROM nginx:alpine AS web
COPY --from=base /app/apps/desktop/dist /usr/share/nginx/html
COPY docker/app/nginx.conf /etc/nginx/conf.d/default.conf
