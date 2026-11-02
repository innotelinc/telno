# Telno — control plane and console.
#
# The product is two apps and one shared contract: a Fastify control plane
# (apps/server), the React console it serves (apps/console), and the vocabulary
# both compile against (packages/shared). There is no PBX in this image — voice
# moved to cantus, which is vendored under vendor/ as a Perl reference stack and
# driven through its CLI, so nothing here generates a dialplan or reserves RTP.
#
#   Build:  docker compose build
#   Run:    docker compose up -d
#
# NODE_IMAGE is an argument so a network that cannot reach Docker Hub can build
# from a mirror without editing this file.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------- build -----
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# The whole workspace graph, not just the server: npm workspaces resolves every
# package before it installs anything, so a missing console manifest fails the
# install that the server needs as well.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/console/package.json ./apps/console/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --no-audit --no-fund

COPY apps ./apps
COPY packages ./packages

# Vite builds the console into apps/console/dist; tsc compiles the server into
# apps/server/dist. The control plane serves the console itself.
RUN npm run build

# -------------------------------------------------------------- runtime -----
FROM ${NODE_IMAGE} AS runtime

# perl runs the vendored cantus stack (Perl 5 core only), curl backs the health
# check, and ca-certificates is what any outbound TLS call needs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      perl curl ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    TELNO_DB=/data/control-plane.db \
    TELNO_CANTUS_DIR=/app/vendor/cantus \
    TELNO_PERL=perl \
    NODE_OPTIONS=--max-old-space-size=256

# Runtime dependencies only. The console is prebuilt static assets and the
# server is compiled, so tsc, tsx, vite and vitest stay out of the image.
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/console/package.json ./apps/console/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# @telno/shared resolves to its TypeScript source on purpose — one contract,
# no build step of its own — and Node 24 strips those types at load time. It
# has to be present as source, not as a dist that is never generated.
COPY packages/shared ./packages/shared

COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/console/dist ./apps/console/dist
COPY vendor ./vendor

# Operator scripts ship with the app: the image is the only thing on a node
# that can run the legacy importer, so it must not live only on the host.
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["node", "apps/server/dist/index.js"]
