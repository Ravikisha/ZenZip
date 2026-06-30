# Reference multi-stage image for a ZenZip app (P16.1).
#
# A ZenZip service is just a Node process that embeds the engine — no Redis, no
# broker, no cron box. This builds your app and runs it on a slim Alpine image.
# ZenZip ships musl prebuilds (P7.19), so the native addon installs cleanly on
# Alpine without a compiler in the final image.
#
# Build:  docker build -f deploy/Dockerfile -t my-zenzip-app .
# Run:    docker run -p 3000:3000 -p 4100:4100 -v zenzip-data:/data my-zenzip-app
#
# State: with the embedded SQLite store, mount a volume at the data dir so it
# survives restarts (zenzip({ dataDir: "/data" })). For multi-node, point the
# app at Postgres and the volume is unnecessary.

# ---- build stage: install deps + compile TypeScript ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# Toolchain only needed if a prebuild is unavailable for this platform; with
# musl prebuilds published this layer is a no-op fast path.
RUN apk add --no-cache libc6-compat
COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN (command -v pnpm >/dev/null && pnpm install --frozen-lockfile) \
    || npm ci || npm install
COPY . .
RUN npm run build --if-present

# ---- runtime stage: minimal, non-root ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache libc6-compat \
    && addgroup -S zenzip && adduser -S zenzip -G zenzip \
    && mkdir -p /data && chown zenzip:zenzip /data
COPY --from=build --chown=zenzip:zenzip /app .
USER zenzip
VOLUME ["/data"]
EXPOSE 3000 4100
# Liveness/readiness are first-class (P7.7): /healthz is zero-I/O, /readyz checks the store.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
