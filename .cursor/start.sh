#!/usr/bin/env bash
# Per-boot startup for the Sunbird Core NestJS backend: bring the native
# PostgreSQL cluster online (its data directory — including migrations and
# seed data — is preserved in the environment snapshot) and wait until it is
# ready to accept connections. Idempotent: a no-op when Postgres is already up.
set -euo pipefail

PG_VER="$(ls /usr/lib/postgresql/ | sort -V | tail -1)"

if ! sudo -u postgres pg_isready -q 2>/dev/null; then
  echo "==> Starting PostgreSQL cluster ${PG_VER}/main"
  sudo pg_ctlcluster "$PG_VER" main start
fi

for _ in $(seq 1 30); do
  if sudo -u postgres pg_isready -q 2>/dev/null; then
    echo "==> PostgreSQL is ready"
    exit 0
  fi
  sleep 1
done

echo "PostgreSQL did not become ready in time" >&2
exit 1
