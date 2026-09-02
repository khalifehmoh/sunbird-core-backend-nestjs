#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the Sunbird Core NestJS backend.
# Installs a native PostgreSQL server (Docker is unavailable in Cloud Agent
# VMs), installs Node dependencies, creates a local .env, then applies the
# Flyway migrations and demo seed. Safe to run repeatedly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DB_NAME="${DB_NAME:-sunbird_core_db}"
DB_USERNAME="${DB_USERNAME:-sunbird_app}"
DB_PASSWORD="${DB_PASSWORD:-sunbird_local_password}"

echo "==> Ensuring PostgreSQL is installed"
if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql postgresql-contrib
fi

PG_VER="$(ls /usr/lib/postgresql/ | sort -V | tail -1)"

echo "==> Starting PostgreSQL cluster ${PG_VER}/main"
if ! sudo -u postgres pg_isready -q 2>/dev/null; then
  sudo pg_ctlcluster "$PG_VER" main start
fi
for _ in $(seq 1 30); do
  sudo -u postgres pg_isready -q 2>/dev/null && break
  sleep 1
done

echo "==> Ensuring database role and database exist"
sudo -u postgres psql -v ON_ERROR_STOP=1 \
  -v role="$DB_USERNAME" -v pass="$DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L SUPERUSER', :'role', :'pass')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role')
\gexec
SQL
sudo -u postgres psql -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || sudo -u postgres createdb -O "$DB_USERNAME" "$DB_NAME"

echo "==> Installing Node dependencies"
npm ci

echo "==> Ensuring .env exists"
if [ ! -f .env ]; then
  cp .env.example .env
  JWT_SECRET="$(openssl rand -hex 32)"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" .env
  echo "Created .env with a generated JWT_SECRET"
fi

echo "==> Applying migrations and demo seed"
node scripts/db-setup.js setup

echo "==> Install complete"
