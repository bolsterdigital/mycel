# One image, several entrypoints (ADR 008: Docker image, Coolify on Hetzner). The same build runs
# as `api`, `web` or `worker` (plus the one-shots `migrate` for deploys, `mycel` for the CLI and
# `mcp` for the MCP server over stdio), chosen by the container command, so the three processes
# can never run different versions of the core. Each of the three answers GET /healthz on $PORT,
# which the HEALTHCHECK below probes.
# Rejected: one image per front, which triples build time and lets versions drift between them.
#
#   docker build -t mycel .
#   docker run --env-file .env -p 3000:3000 mycel web     # or: api | worker | migrate | mycel | mcp

ARG NODE_VERSION=22.22.0

# --- build: full install, compile the workspaces and the SvelteKit app ----------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/api/package.json packages/api/
COPY packages/mail-tem/package.json packages/mail-tem/
COPY packages/assist-openai/package.json packages/assist-openai/
COPY packages/blob/package.json packages/blob/
COPY packages/media-sharp/package.json packages/media-sharp/
COPY packages/observability/package.json packages/observability/
COPY packages/mcp/package.json packages/mcp/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# --- runtime: production dependencies plus the compiled output only -------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# Set by the release workflow from the tag (TODO #18b); read by `mycel version` and the gauge
# mycel_build_info. Empty in a local build, which then reports the root package.json.
ARG MYCEL_VERSION=
ENV NODE_ENV=production \
    PORT=3000 \
    MYCEL_VERSION=${MYCEL_VERSION}
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/db/package.json packages/db/
COPY --from=build /app/packages/api/package.json packages/api/
COPY --from=build /app/packages/mail-tem/package.json packages/mail-tem/
COPY --from=build /app/packages/assist-openai/package.json packages/assist-openai/
COPY --from=build /app/packages/blob/package.json packages/blob/
COPY --from=build /app/packages/media-sharp/package.json packages/media-sharp/
COPY --from=build /app/packages/observability/package.json packages/observability/
COPY --from=build /app/packages/mcp/package.json packages/mcp/
COPY --from=build /app/apps/web/package.json apps/web/
# sharp needs no install script: its libvips binary for this platform (linux-x64 or arm64, glibc)
# is an optional dependency (@img/sharp-*), installed by npm ci like any other package.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/migrations packages/db/migrations
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/mail-tem/dist packages/mail-tem/dist
COPY --from=build /app/packages/assist-openai/dist packages/assist-openai/dist
COPY --from=build /app/packages/blob/dist packages/blob/dist
COPY --from=build /app/packages/media-sharp/dist packages/media-sharp/dist
COPY --from=build /app/packages/observability/dist packages/observability/dist
COPY --from=build /app/packages/mcp/dist packages/mcp/dist
COPY --from=build /app/apps/web/build apps/web/build
COPY docker/entrypoint.sh docker/healthcheck.mjs /usr/local/lib/mycel/

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "/usr/local/lib/mycel/healthcheck.mjs"]
ENTRYPOINT ["/usr/local/lib/mycel/entrypoint.sh"]
CMD ["api"]
