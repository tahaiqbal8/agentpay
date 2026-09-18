# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build
#
# Dependencies are compiled in their own layer against a stub main.rs, so a
# source change rebuilds only this crate instead of all ~450 dependencies.
# Without that split, every edit is a 10-20 minute rebuild.
#
# Debian rather than Alpine on purpose: sqlx uses native-tls, and linking
# OpenSSL against musl is a fight with no upside here.
# ---------------------------------------------------------------------------
FROM rust:1.98-bookworm AS builder

WORKDIR /build

# Dependency layer. Cached until Cargo.toml/Cargo.lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src \
 && echo 'fn main() { println!("stub"); }' > src/main.rs \
 && cargo build --release \
 && rm -rf src

# Real sources. `migrations/` must be present: sqlx::migrate! embeds them at
# compile time, which is what makes the runtime image self-contained.
COPY src ./src
COPY migrations ./migrations

# cargo skips rebuilding if mtime looks unchanged after the stub.
RUN touch src/main.rs && cargo build --release

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 curl \
 && rm -rf /var/lib/apt/lists/*

# Non-root. The gateway holds the provider signing key when settlement is
# enabled, so it has no business running as root.
RUN useradd --system --create-home --uid 10001 agentpay
USER agentpay
WORKDIR /home/agentpay

COPY --from=builder /build/target/release/agentpay-gateway /usr/local/bin/agentpay-gateway

# 0.0.0.0 inside the container only. Compose publishes it to 127.0.0.1 on the
# host, so it is not reachable from the network.
ENV AGENTPAY_BIND_ADDR=0.0.0.0:8080
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/usr/local/bin/agentpay-gateway"]
