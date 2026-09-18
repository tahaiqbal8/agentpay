# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Next.js console.
#
# Uses `output: "standalone"`, which traces the actual imports and emits a
# server bundle with only the node_modules it needs — a few hundred MB smaller
# than shipping the full dependency tree.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10002 nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3100
ENV HOSTNAME=0.0.0.0

COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3100

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3100/ || exit 1

CMD ["node", "server.js"]
