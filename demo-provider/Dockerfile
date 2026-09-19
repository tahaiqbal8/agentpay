# syntax=docker/dockerfile:1
#
# Zero npm dependencies, so there is nothing to install and no build step.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10003 provider

WORKDIR /app
COPY server.js ./
USER provider

ENV PORT=4021
EXPOSE 4021

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=5 \
  CMD curl -fsS http://127.0.0.1:4021/health || exit 1

CMD ["node", "server.js"]
