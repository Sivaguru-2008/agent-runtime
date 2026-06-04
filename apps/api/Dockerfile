# syntax=docker/dockerfile:1
#
# Production image for the Agent Runtime API (apps/api).
#
# Build context MUST be the repository root (so npm workspaces resolve):
#   docker build -f apps/api/Dockerfile -t agent-runtime-api .
#
# Runtime entry: node apps/api/dist/server.js
#   • Runs pending Postgres migrations on boot (server.ts) — fail-fast in prod.
#   • Binds API_HOST (default "::", dual-stack) on PORT (default 4000).
#   • /health is unauthenticated for load-balancer + uptime probes.
#
# Required env at runtime (see docs/deploy.md):
#   NODE_ENV=production  DATABASE_URL=...  DATABASE_SSL=require
#   AUTH_ENABLED=true    PERSISTENCE_DRIVER=postgres  EVENT_STORE_DRIVER=postgres

# ── Stage 1: build (TypeScript → dist) ───────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install deps with the lockfile first for cache reuse. Copy only the manifests
# the workspace graph needs to resolve so source edits don't bust the npm layer.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN npm ci

# Build only the API workspace.
COPY apps/api apps/api
COPY scripts scripts
RUN npm run build -w apps/api

# ── Stage 2: runtime (resolved deps + compiled output only) ──────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Reuse the dependency tree the builder already resolved (hoisted to the root
# node_modules by npm workspaces) rather than reinstalling — a fresh `npm ci`
# in the runner would have to reconcile the whole-monorepo lockfile against a
# context that only carries the API's manifest. All of the API's runtime deps
# (fastify, pg, pino, prom-client, zod, otel) are pure-JS and hoist cleanly.
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/package.json package.json
COPY --from=builder /app/apps/api/package.json apps/api/package.json

# Compiled JS (entrypoint dist/server.js) + the SQL the migration runner reads
# at boot. server.ts resolves db/ as dist/../db, i.e. apps/api/db.
COPY --from=builder /app/apps/api/dist apps/api/dist
COPY --from=builder /app/apps/api/db apps/api/db

# The owner-key bootstrap script (run once, out-of-band — see docs/deploy.md).
COPY --from=builder /app/scripts/seed-owner-key.mjs scripts/seed-owner-key.mjs

# Drop root for the running process.
USER node

EXPOSE 4000
ENV PORT=4000 API_HOST="::"

# Lightweight container healthcheck hitting the unauthenticated liveness route.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
