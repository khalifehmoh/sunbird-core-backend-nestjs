#!/usr/bin/env node
/**
 * Recreate the Sunbird core database on another machine.
 *
 *   npm run db:setup          migrate Flyway SQL, then seed demo data
 *   npm run db:migrate        schema only
 *   npm run db:seed           seed only (skipped if users already exist)
 *   npm run db:dump           refresh db/seed/core/010_demo_snapshot.sql
 *
 * Flags: --reseed  truncate seed tables and reload snapshot
 *
 * Reads DB_* from .env. Optional DB_ADMIN_USERNAME / DB_ADMIN_PASSWORD
 * (defaults to postgres) are used to create the database, schema, and
 * extensions on a fresh PostgreSQL install.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_DIR = path.join(ROOT, 'db', 'migration');
const SEED_DIR = path.join(ROOT, 'db', 'seed');
const SNAPSHOT_PATH = path.join(SEED_DIR, 'core', '010_demo_snapshot.sql');
const ENV_PATH = path.join(ROOT, '.env');

const FLYWAY_HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS core.flyway_schema_history (
    installed_rank INTEGER NOT NULL,
    version VARCHAR(50),
    description VARCHAR(200) NOT NULL,
    type VARCHAR(20) NOT NULL,
    script VARCHAR(1000) NOT NULL,
    checksum INTEGER,
    installed_by VARCHAR(100) NOT NULL,
    installed_on TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
    execution_time INTEGER NOT NULL,
    success BOOLEAN NOT NULL,
    CONSTRAINT flyway_schema_history_pk PRIMARY KEY (installed_rank)
);
CREATE INDEX IF NOT EXISTS flyway_schema_history_s_idx
    ON core.flyway_schema_history (success);
`;

const SEED_TABLES = [
  'core.user_roles',
  'core.group_members',
  'core.group_roles',
  'core.groups',
  'core.user_tenant_access',
  'core.users',
  'core.role_permissions',
  'core.permissions',
  'core.roles',
  'core.branches',
  'core.modules',
  'core.tenant_config',
  'core.tenants',
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) | 0;
}

function flywayChecksum(filePath) {
  let buffer = fs.readFileSync(filePath);
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    buffer = buffer.subarray(3);
  }
  return crc32(buffer);
}

function flywayDescription(fileName) {
  const match = fileName.match(/^V\d+__(.+)\.sql$/i);
  const raw = match ? match[1] : fileName;
  return raw.replaceAll('_', ' ');
}

function flywayVersion(fileName) {
  const match = fileName.match(/^V(\d+)/i);
  return match ? String(Number(match[1])) : null;
}

function listSqlFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSqlFiles(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sql')) {
      files.push(full);
    }
  }
  return files.sort((a, b) => a.localeCompare(b, 'en'));
}

function stripPsqlMeta(sql) {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
}

function config() {
  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'sunbird_core_db',
    user: process.env.DB_USERNAME ?? 'sunbird_app',
    password: process.env.DB_PASSWORD,
    adminUser: process.env.DB_ADMIN_USERNAME ?? 'postgres',
    adminPassword: process.env.DB_ADMIN_PASSWORD,
  };
}

function appClientOptions(cfg, database = cfg.database) {
  return {
    host: cfg.host,
    port: cfg.port,
    database,
    user: cfg.user,
    password: cfg.password,
  };
}

function adminClientOptions(cfg, database = 'postgres') {
  if (!cfg.adminPassword) {
    return null;
  }
  return {
    host: cfg.host,
    port: cfg.port,
    database,
    user: cfg.adminUser,
    password: cfg.adminPassword,
  };
}

async function withClient(options, fn) {
  const client = new Client(options);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function queryOk(options, sql) {
  try {
    await withClient(options, (client) => client.query(sql));
    return true;
  } catch {
    return false;
  }
}

async function ensureDatabase(cfg) {
  const appDb = appClientOptions(cfg);
  if (await queryOk(appDb, 'SELECT 1')) {
    return;
  }

  const adminPostgres = adminClientOptions(cfg, 'postgres');
  if (!adminPostgres) {
    throw new Error(
      `Cannot connect to ${cfg.database} as ${cfg.user}. ` +
        `Create the database (see scripts/bootstrap-postgres.sql) or set ` +
        `DB_ADMIN_USERNAME / DB_ADMIN_PASSWORD in .env so this script can create it.`,
    );
  }

  await withClient(adminPostgres, async (client) => {
    const existing = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [cfg.database],
    );
    if (existing.rowCount === 0) {
      const ownerExists = await client.query(
        'SELECT 1 FROM pg_roles WHERE rolname = $1',
        [cfg.user],
      );
      if (ownerExists.rowCount === 0) {
        await client.query(
          `CREATE ROLE ${quoteIdent(cfg.user)} LOGIN PASSWORD ${quoteLiteral(cfg.password)}`,
        );
        console.log(`Created role ${cfg.user}`);
      }
      await client.query(
        `CREATE DATABASE ${quoteIdent(cfg.database)} OWNER ${quoteIdent(cfg.user)}`,
      );
      console.log(`Created database ${cfg.database}`);
    }
  });

  const adminDb = adminClientOptions(cfg, cfg.database);
  await withClient(adminDb, async (client) => {
    await client.query(`GRANT ALL PRIVILEGES ON DATABASE ${quoteIdent(cfg.database)} TO ${quoteIdent(cfg.user)}`);
    await client.query(
      `GRANT ${quoteIdent(cfg.user)} TO ${quoteIdent(cfg.adminUser)}`,
    ).catch(() => undefined);
  });
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function tryQuery(client, sql) {
  try {
    await client.query(sql);
    return true;
  } catch {
    return false;
  }
}

async function prepareSchema(client, cfg) {
  await client.query('CREATE SCHEMA IF NOT EXISTS core');
  await tryQuery(
    client,
    `GRANT USAGE, CREATE ON SCHEMA core TO ${quoteIdent(cfg.user)}`,
  );
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA core');
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA core');
  } catch (error) {
    throw new Error(
      `CREATE EXTENSION failed (${error.message}). Run scripts/bootstrap-postgres.sql as a superuser, ` +
        `or set DB_ADMIN_PASSWORD so this script can connect as ${cfg.adminUser}.`,
    );
  }
}

async function grantAppUser(client, cfg) {
  await tryQuery(client, `GRANT ALL ON SCHEMA core TO ${quoteIdent(cfg.user)}`);
  await tryQuery(
    client,
    `GRANT ALL ON ALL TABLES IN SCHEMA core TO ${quoteIdent(cfg.user)}`,
  );
  await tryQuery(
    client,
    `GRANT ALL ON ALL SEQUENCES IN SCHEMA core TO ${quoteIdent(cfg.user)}`,
  );
  await tryQuery(
    client,
    `GRANT ALL ON ALL FUNCTIONS IN SCHEMA core TO ${quoteIdent(cfg.user)}`,
  );
}

async function appliedVersions(client) {
  const table = await client.query(
    `SELECT to_regclass('core.flyway_schema_history') AS name`,
  );
  if (!table.rows[0]?.name) {
    return new Set();
  }
  const result = await client.query(
    `SELECT version FROM core.flyway_schema_history WHERE success = TRUE AND version IS NOT NULL`,
  );
  return new Set(result.rows.map((row) => String(row.version)));
}

function collectMigrations() {
  return listSqlFiles(MIGRATION_DIR)
    .map((filePath) => {
      const fileName = path.basename(filePath);
      const relative = path
        .relative(MIGRATION_DIR, filePath)
        .split(path.sep)
        .join('/');
      return {
        filePath,
        fileName,
        relative,
        version: flywayVersion(fileName),
        description: flywayDescription(fileName),
        checksum: flywayChecksum(filePath),
      };
    })
    .filter((migration) => migration.version)
    .sort((a, b) => Number(a.version) - Number(b.version));
}

async function ensureFlywayHistory(client) {
  const exists = await client.query(
    `SELECT to_regclass('core.flyway_schema_history') AS name`,
  );
  if (exists.rows[0]?.name) {
    return;
  }
  await client.query(FLYWAY_HISTORY_TABLE);
}

async function migrate(client, cfg) {
  await prepareSchema(client, cfg);
  await ensureFlywayHistory(client);

  const applied = await appliedVersions(client);
  const migrations = collectMigrations();
  if (migrations.length === 0) {
    throw new Error(`No Flyway SQL files found under ${MIGRATION_DIR}`);
  }

  let ran = 0;
  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      console.log(`Already applied V${migration.version} ${migration.relative}`);
      continue;
    }
    const started = Date.now();
    await client.query(fs.readFileSync(migration.filePath, 'utf8'));
    const executionTime = Date.now() - started;
    const rank = await client.query(
      `SELECT COALESCE(MAX(installed_rank), 0) + 1 AS next FROM core.flyway_schema_history`,
    );
    await client.query(
      `INSERT INTO core.flyway_schema_history (
         installed_rank, version, description, type, script, checksum,
         installed_by, execution_time, success
       ) VALUES ($1, $2, $3, 'SQL', $4, $5, $6, $7, TRUE)`,
      [
        rank.rows[0].next,
        migration.version,
        migration.description,
        migration.relative,
        migration.checksum,
        cfg.user,
        executionTime,
      ],
    );
    console.log(`Applied V${migration.version} ${migration.relative}`);
    ran += 1;
  }

  await grantAppUser(client, cfg);
  if (ran === 0) {
    console.log('Schema is up to date.');
  }
}

async function userCount(client) {
  const exists = await client.query(`SELECT to_regclass('core.users') AS name`);
  if (!exists.rows[0]?.name) {
    return 0;
  }
  const result = await client.query(`SELECT COUNT(*)::int AS count FROM core.users`);
  return result.rows[0].count;
}

async function seed(client, reseed) {
  const existing = await userCount(client);
  if (existing > 0 && !reseed) {
    console.log(
      `Seed skipped (${existing} users already present). Pass --reseed to reload demo data.`,
    );
    return;
  }

  if (reseed) {
    await client.query(`TRUNCATE TABLE ${SEED_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    console.log('Truncated seed tables.');
  }

  const files = listSqlFiles(SEED_DIR);
  if (files.length === 0) {
    console.log(`No seed files found under ${SEED_DIR}`);
    return;
  }

  for (const filePath of files) {
    const relative = path.relative(ROOT, filePath);
    const sql = stripPsqlMeta(fs.readFileSync(filePath, 'utf8'));
    await client.query(sql);
    console.log(`Seeded ${relative.replaceAll('\\', '/')}`);
  }
}

function findPgDump() {
  const fromEnv = process.env.PG_DUMP;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pg_dump'], {
    encoding: 'utf8',
  });
  if (which.status === 0) {
    const first = which.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) {
      return first;
    }
  }
  if (process.platform === 'win32') {
    const guess = 'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe';
    if (fs.existsSync(guess)) {
      return guess;
    }
  }
  return null;
}

function dump(cfg) {
  const pgDump = findPgDump();
  if (!pgDump) {
    throw new Error(
      'pg_dump not found. Install PostgreSQL client tools or set PG_DUMP to the executable path.',
    );
  }

  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  const result = spawnSync(
    pgDump,
    [
      '-h',
      cfg.host,
      '-p',
      String(cfg.port),
      '-U',
      cfg.user,
      '-d',
      cfg.database,
      '--schema=core',
      '--data-only',
      '--inserts',
      '--column-inserts',
      '--no-owner',
      '--no-privileges',
      '--exclude-table-data=core.audit_logs',
      '--exclude-table-data=core.user_sessions',
      '--exclude-table-data=core.refresh_sessions',
      '--exclude-table-data=core.password_reset_tokens',
      '--exclude-table-data=core.flyway_schema_history',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: cfg.password },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `pg_dump exited with code ${result.status}`);
  }

  const body = stripPsqlMeta(result.stdout)
    .replace(/^SET statement_timeout = 0;/m, '')
    .trim();
  const snapshot = [
    '-- Local demo snapshot (tenants, users, roles, permissions, branches).',
    '-- Regenerated with: npm run db:dump',
    '-- Sessions, audit logs, and refresh tokens are omitted.',
    '',
    'SET statement_timeout = 0;',
    '',
    body,
    '',
  ].join('\n');
  fs.writeFileSync(SNAPSHOT_PATH, snapshot, 'utf8');
  console.log(`Wrote ${path.relative(ROOT, SNAPSHOT_PATH).replaceAll('\\', '/')}`);
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const command = argv.find((arg) => !arg.startsWith('--')) ?? 'setup';
  return {
    command,
    reseed: flags.has('--reseed') || flags.has('--force'),
  };
}

function usage() {
  console.log(`Usage: node scripts/db-setup.js [setup|migrate|seed|dump] [--reseed]

  setup     Create DB if needed, apply db/migration, then db/seed (default)
  migrate   Apply pending Flyway SQL files only
  seed      Load demo snapshot (skipped when users already exist)
  dump      Refresh db/seed/core/010_demo_snapshot.sql from the current database

  --reseed  Truncate seed tables and reload snapshot`);
}

async function connectForWork(cfg) {
  const adminDb = adminClientOptions(cfg, cfg.database);
  if (adminDb && (await queryOk(adminDb, 'SELECT 1'))) {
    return { options: adminDb, asAdmin: true };
  }
  return { options: appClientOptions(cfg), asAdmin: false };
}

async function main() {
  loadEnvFile(ENV_PATH);
  const { command, reseed } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '-h' || command === '--help') {
    usage();
    return;
  }

  const cfg = config();
  if (!cfg.password) {
    throw new Error('DB_PASSWORD is required. Copy .env.example to .env.');
  }

  if (command === 'dump') {
    dump(cfg);
    return;
  }

  if (!['setup', 'migrate', 'seed'].includes(command)) {
    usage();
    process.exitCode = 1;
    return;
  }

  await ensureDatabase(cfg);
  const { options, asAdmin } = await connectForWork(cfg);
  await withClient(options, async (client) => {
    if (command === 'migrate' || command === 'setup') {
      await migrate(client, cfg);
    }
    if (command === 'seed' || command === 'setup') {
      await seed(client, reseed);
    }
  });
  console.log(`Done (${asAdmin ? cfg.adminUser : cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}).`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
