# ---- deps: install production node_modules ----
# Full bookworm (not slim) so the toolchain (python3/make/g++) is present to compile
# better-sqlite3's native addon — there is no prebuilt binary for this target, so npm ci
# falls back to node-gyp. The compiled .node is glibc-linked and copied into the slim
# runtime below, which shares the same Debian bookworm glibc.
FROM node:22-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- build: compile TS + bundle the SPA into /app/dist ----
# Also full bookworm: `npm ci` here installs all deps (incl. better-sqlite3), which runs the
# same native compile and needs the toolchain.
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: Express serves the JSON API + the built SPA on one port ----
# Slim: no toolchain needed at runtime, the prebuilt-in-CI node_modules (with the compiled
# better-sqlite3 .node) is copied in, and slim's glibc matches what it was linked against.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3179
# Only the storage server runs at runtime; the SPA is prebuilt into dist.
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
# Data (db.sqlite + JSON backups) is written under /app/data — mount a volume/PVC there to persist.
EXPOSE 3179
CMD ["node", "server/index.mjs"]
