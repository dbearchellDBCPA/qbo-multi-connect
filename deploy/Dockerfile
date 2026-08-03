# ── Build stage ──────────────────────────────────────────────────────────────
# Compiles TypeScript and builds the better-sqlite3 native addon. Uses the same
# base image as runtime so the compiled .node binary is ABI-compatible.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain for node-gyp (better-sqlite3 native build)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies; keeps better-sqlite3 and its compiled binary.
RUN npm prune --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Data (SQLite DB + auto-generated secrets) lives on a mounted volume at /data.
ENV QBO_DB_PATH=/data/qbo-connections.db
ENV PORT=3456

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# No VOLUME instruction: Railway's builder rejects it (attach a Railway
# Volume at /data instead), and plain Docker mounts (-v name:/data) don't
# need one. The directory just has to exist for volume-less test runs.
RUN mkdir -p /data
EXPOSE 3456

# Liveness: the server exposes an unauthenticated /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3456)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
