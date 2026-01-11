# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1.3-alpine AS base
WORKDIR /app
RUN mkdir -p /app/cloud_data

FROM base AS cloud
RUN apk add --no-cache curl
RUN apk add --no-cache python3 make g++
ENV CXXFLAGS="-std=c++20"
ENV npm_config_cxxstd=gnu++20
ENV MINDWTR_CLOUD_DATA_DIR=/app/cloud_data

COPY --chown=1000:1000 . .
RUN chown bun:bun /app
USER bun
RUN bun install

# Run the cloud service
EXPOSE 8787/tcp
ENTRYPOINT ["bun", "run", "--filter", "mindwtr-cloud", "dev", "--", "--host", "0.0.0.0", "--port", "8787"]
