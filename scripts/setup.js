#!/usr/bin/env node
/**
 * One-command backend bootstrap for a new machine.
 *
 *   npm run setup        install, .env, Postgres, migrate, seed
 *   npm run setup:dev    same, then start the API
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
const JWT_PLACEHOLDER = 'replace-with-a-random-secret-at-least-32-characters-long';

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

function upsertEnvValue(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }
  return `${contents.trimEnd()}\n${line}\n`;
}

function ensureEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    if (!fs.existsSync(ENV_EXAMPLE_PATH)) {
      throw new Error('Missing .env.example — cannot create .env');
    }
    fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
    console.log('Created .env from .env.example');
  }

  let contents = fs.readFileSync(ENV_PATH, 'utf8');
  const jwtMatch = contents.match(/^JWT_SECRET=(.*)$/m);
  const jwt = jwtMatch ? jwtMatch[1].trim() : '';
  if (!jwt || jwt === JWT_PLACEHOLDER || jwt.length < 32) {
    const secret = crypto.randomBytes(32).toString('hex');
    contents = upsertEnvValue(contents, 'JWT_SECRET', secret);
    fs.writeFileSync(ENV_PATH, contents, 'utf8');
    console.log('Generated JWT_SECRET in .env');
  }
}

function dbConfig() {
  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'sunbird_core_db',
    user: process.env.DB_USERNAME ?? 'sunbird_app',
    password: process.env.DB_PASSWORD,
    adminPassword: process.env.DB_ADMIN_PASSWORD,
  };
}

function classifyPgError(error) {
  const code = error.code;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET'
  ) {
    return 'down';
  }
  if (code === '3D000') {
    return 'missing-database';
  }
  if (code === '28P01' || code === '28000' || code === '26P000') {
    return 'auth-failed';
  }
  return 'unknown';
}

async function probe(cfg, database) {
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    database,
    user: cfg.user,
    password: cfg.password,
    connectionTimeoutMillis: 2500,
  });
  try {
    await client.connect();
    await client.end();
    return { status: 'ok' };
  } catch (error) {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    return { status: classifyPgError(error), message: error.message };
  }
}

async function postgresStatus(cfg) {
  const primary = await probe(cfg, cfg.database);
  if (primary.status === 'ok' || primary.status === 'missing-database') {
    return primary.status === 'ok' ? 'ready' : 'missing-database';
  }
  const fallback = await probe(cfg, 'postgres');
  if (fallback.status === 'ok' || fallback.status === 'missing-database') {
    return 'missing-database';
  }
  if (primary.status === 'auth-failed' || fallback.status === 'auth-failed') {
    return 'auth-failed';
  }
  if (primary.status === 'down' && fallback.status === 'down') {
    return 'down';
  }
  return 'unknown';
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status ?? 'unknown'})`);
  }
}

function dockerCompose() {
  const compose = spawnSync('docker', ['compose', 'version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (compose.status === 0) {
    return { command: 'docker', prefix: ['compose'] };
  }
  const legacy = spawnSync('docker-compose', ['version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (legacy.status === 0) {
    return { command: 'docker-compose', prefix: [] };
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function startDockerPostgres() {
  const compose = dockerCompose();
  if (!compose) {
    return false;
  }
  console.log('Starting PostgreSQL with Docker Compose...');
  run(compose.command, [...compose.prefix, 'up', '-d', 'postgres'], {
    shell: process.platform === 'win32',
  });
  return true;
}

async function waitUntilReady(cfg, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await postgresStatus(cfg);
    if (status === 'ready' || status === 'missing-database') {
      return status;
    }
    process.stdout.write('.');
    await sleep(2000);
  }
  process.stdout.write('\n');
  throw new Error(
    `PostgreSQL did not become ready on ${cfg.host}:${cfg.port} within ${timeoutMs / 1000}s.`,
  );
}

async function ensurePostgres(cfg) {
  let status = await postgresStatus(cfg);
  if (status === 'ready' || status === 'missing-database') {
    console.log(
      status === 'ready'
        ? `PostgreSQL is reachable at ${cfg.host}:${cfg.port}.`
        : `PostgreSQL is up; database ${cfg.database} will be created.`,
    );
    return;
  }

  if (status === 'auth-failed') {
    throw new Error(
      `PostgreSQL rejected ${cfg.user} / DB_PASSWORD. Update DB_PASSWORD in .env to match your server, ` +
        `or set DB_ADMIN_PASSWORD so the setup script can create the role.`,
    );
  }

  const startedDocker = await startDockerPostgres();
  if (!startedDocker) {
    throw new Error(
      'PostgreSQL is not running and Docker is not available. ' +
        'Install Docker Desktop (then re-run npm run setup) or install PostgreSQL and set DB_ADMIN_PASSWORD in .env.',
    );
  }

  process.stdout.write('Waiting for PostgreSQL');
  await waitUntilReady(cfg);
  process.stdout.write('\n');
  console.log('PostgreSQL is ready.');
}

function printNextSteps() {
  console.log(`
Backend setup is complete.

  API:    http://localhost:8080
  Health: http://localhost:8080/api/v1/health
  Login:  admin@alrajhimedical.sa
          (password is in LOCAL_CREDENTIALS.md)

Start the API:

  npm run start:dev
`);
}

async function main() {
  const reseed = process.argv.includes('--reseed') || process.argv.includes('--force');

  console.log('==> Checking .env');
  ensureEnv();
  loadEnvFile(ENV_PATH);

  const cfg = dbConfig();
  if (!cfg.password) {
    throw new Error('DB_PASSWORD is empty. Set it in .env.');
  }

  console.log('==> Ensuring PostgreSQL');
  await ensurePostgres(cfg);

  console.log('==> Migrating and seeding');
  const dbArgs = ['scripts/db-setup.js', 'setup'];
  if (reseed) {
    dbArgs.push('--reseed');
  }
  run(process.execPath, dbArgs);

  printNextSteps();
}

main().catch((error) => {
  console.error(`\nSetup failed: ${error.message || error}`);
  process.exitCode = 1;
});
