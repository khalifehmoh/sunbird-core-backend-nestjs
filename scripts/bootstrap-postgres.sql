-- One-time superuser bootstrap for a new machine.
--
--   psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f scripts/bootstrap-postgres.sql
--
-- Set the sunbird_app password to the same value as DB_PASSWORD in .env.
-- Prefer `npm run db:setup` with DB_ADMIN_PASSWORD set — that creates the
-- database automatically. Use this file when you would rather do it in psql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sunbird_app') THEN
    CREATE ROLE sunbird_app LOGIN PASSWORD 'change-me';
  END IF;
END
$$;

SELECT format(
    'CREATE DATABASE %I OWNER %I',
    'sunbird_core_db',
    'sunbird_app'
)
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'sunbird_core_db')
\gexec

\connect sunbird_core_db

CREATE SCHEMA IF NOT EXISTS core;
GRANT USAGE, CREATE ON SCHEMA core TO sunbird_app;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA core;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA core;
GRANT ALL ON SCHEMA core TO sunbird_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT ALL ON TABLES TO sunbird_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT ALL ON SEQUENCES TO sunbird_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT ALL ON FUNCTIONS TO sunbird_app;
