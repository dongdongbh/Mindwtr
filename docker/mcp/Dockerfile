FROM oven/bun:1.3.5-alpine@sha256:7156fcc0cee0194d390bfaf7f0eeda9a5e383e70cc90f31aad3a2440a033d7dc AS build
WORKDIR /build

COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
COPY apps/cloud/package.json ./apps/cloud/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY apps/mobile/modules/gmail-authorization/package.json ./apps/mobile/modules/gmail-authorization/package.json
COPY apps/mcp-server/package.json ./apps/mcp-server/package.json
COPY packages/core/package.json ./packages/core/package.json
RUN bun install --frozen-lockfile --ignore-scripts --no-optional --filter mindwtr-mcp --filter @mindwtr/core

COPY apps/mcp-server/src ./apps/mcp-server/src
COPY packages/core/src ./packages/core/src
RUN bun run --filter mindwtr-mcp build

ARG MCP_VERSION=1.1.14
RUN test "$(bun -p "require('./apps/mcp-server/package.json').version")" = "$MCP_VERSION"

FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime
ARG MCP_VERSION=1.1.14
ARG SOURCE_REVISION
LABEL org.opencontainers.image.title="Mindwtr MCP" \
      org.opencontainers.image.description="Mindwtr MCP for the desktop Local API and self-hosted Cloud" \
      org.opencontainers.image.source="https://github.com/dongdongbh/Mindwtr" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="$MCP_VERSION" \
      org.opencontainers.image.revision="$SOURCE_REVISION"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /build/apps/mcp-server/dist ./dist
COPY --from=build /build/apps/mcp-server/package.json ./package.json
COPY LICENSE ./LICENSE
USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
