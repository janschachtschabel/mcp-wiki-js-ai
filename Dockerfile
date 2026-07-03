# =============================================================================
# wikijs-mcp — production image for the MCP server (mcp-for-wiki-js/)
# =============================================================================
# Wiki.js itself is NOT built here — it runs from the official requarks/wiki:2
# image (see docker-compose.yml). This image contains only the MCP server as a
# self-contained Next.js standalone bundle on Node 24 (node:sqlite is stable
# there — the OAuth session store needs no native modules).
#
# Build:  docker build -t wikijs-mcp .
# Run:    docker run -p 3000:3000 -v mcp-data:/data -e MCP_SESSION_SECRET=... wikijs-mcp

FROM node:24-alpine AS deps
WORKDIR /app
COPY mcp-for-wiki-js/package.json mcp-for-wiki-js/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY mcp-for-wiki-js/ ./
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    MCP_DATA_DIR=/data
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
VOLUME /data
# Liveness only — deliberately independent of Wiki.js availability.
# Shell form so ${PORT} expands at runtime; a PORT override stays healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["node", "server.js"]
