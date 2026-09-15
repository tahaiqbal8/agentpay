#!/usr/bin/env bash
#
# Dedicated PostgreSQL for AgentPay development.
#
# Deliberately on port 5434: 5432 and 5433 are commonly taken by other projects,
# and this must never share a database with one of them.
#
# Usage: ./scripts/dev-db.sh [up|down|reset|url|psql]
set -euo pipefail

CONTAINER="${AGENTPAY_DB_CONTAINER:-agentpay-postgres}"
PORT="${AGENTPAY_DB_PORT:-5434}"
USER="agentpay"
PASS="agentpay"
DB="agentpay"
URL="postgres://${USER}:${PASS}@127.0.0.1:${PORT}/${DB}"

case "${1:-up}" in
  up)
    if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
      echo "already running on port $PORT"
    else
      docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
      docker run -d --name "$CONTAINER" \
        -e POSTGRES_USER="$USER" \
        -e POSTGRES_PASSWORD="$PASS" \
        -e POSTGRES_DB="$DB" \
        -p "${PORT}:5432" \
        postgres:16-alpine >/dev/null
      printf "waiting for postgres"
      until docker exec "$CONTAINER" pg_isready -U "$USER" >/dev/null 2>&1; do
        printf "."; sleep 1
      done
      echo " ready"
    fi
    echo "DATABASE_URL=$URL"
    ;;
  down)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "stopped" || echo "not running"
    ;;
  reset)
    # Drops every row. Migrations re-run on the next gateway start.
    docker exec "$CONTAINER" psql -U "$USER" -d "$DB" \
      -c "DROP TABLE IF EXISTS claim_tickets, sessions, _sqlx_migrations CASCADE;" >/dev/null
    echo "schema dropped; restart the gateway to re-migrate"
    ;;
  url)  echo "$URL" ;;
  psql) exec docker exec -it "$CONTAINER" psql -U "$USER" -d "$DB" ;;
  *)    echo "usage: $0 [up|down|reset|url|psql]" >&2; exit 1 ;;
esac
