#!/usr/bin/env node
/**
 * Provision the event-driven spike in every tenant Project: one Medplum Bot +
 * two Subscriptions that fire on Encounter updates.
 *
 *   Path A — Subscription → Bot (runs inside Medplum vmcontext)
 *   Path B — Subscription → Nest rest-hook → BullMQ on Medplum Redis
 *
 * Both write the same FHIR Communication (NOTIF_ADT_DISCHARGE stand-in), tagged
 * with event-path=bot|bullmq so you can compare outcomes.
 *
 *   npm run medplum:events
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const lib = require('./lib/medplum-admin');

const BOT_NAME = 'Spike: discharge notification';
const SUB_BOT_REASON = 'Spike: Encounter → Medplum Bot (discharge notification)';
const SUB_BULLMQ_REASON =
  'Spike: Encounter → Nest BullMQ (discharge notification)';
const EVENT_PATH_SYSTEM = 'https://sunbird.health/fhir/event-path';
const EVENT_NOTIFICATION_SYSTEM =
  'https://sunbird.health/fhir/event-notification';

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function cfg() {
  loadEnvFile(ENV_PATH);
  return {
    baseUrl: (process.env.MEDPLUM_BASE_URL || 'http://localhost:8103/').replace(
      /\/?$/,
      '/',
    ),
    tenantsFile: path.resolve(
      ROOT,
      process.env.MEDPLUM_TENANTS_FILE ?? '.medplum/tenants.json',
    ),
    webhookUrl:
      process.env.EVENTS_WEBHOOK_URL ||
      'http://host.docker.internal:8080/api/v1/events/fhir-subscription',
    secret:
      process.env.EVENTS_SUBSCRIPTION_SECRET ||
      'local-subscription-secret-change-me',
  };
}

async function fhir(c, accessToken, method, urlPath, body) {
  const res = await fetch(new URL(`fhir/R4/${urlPath}`, c.baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/fhir+json',
      ...(body ? { 'content-type': 'application/fhir+json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} → ${res.status} ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

async function search(c, accessToken, resourceType, params) {
  const qs = new URLSearchParams(params).toString();
  return fhir(c, accessToken, 'GET', `${resourceType}?${qs}`);
}

/**
 * Discharge-notification Bot — same side-effect as the BullMQ worker.
 * Plain CommonJS: Medplum vmcontext runs bots via vm.Script (no ESM imports).
 */
function botSource() {
  return `
const EVENT_PATH_SYSTEM = '${EVENT_PATH_SYSTEM}';
const EVENT_NOTIFICATION_SYSTEM = '${EVENT_NOTIFICATION_SYSTEM}';

async function handler(medplum, event) {
  const encounter = event.input;
  if (!encounter || encounter.resourceType !== 'Encounter') {
    return { skipped: true, reason: 'not-encounter' };
  }
  if (encounter.status !== 'finished' || !encounter.id) {
    return { skipped: true, reason: 'not-finished', status: encounter.status };
  }

  const existing = await medplum.searchOne('Communication', {
    identifier: EVENT_NOTIFICATION_SYSTEM + '|discharge-' + encounter.id + '-bot',
  });
  if (existing) {
    return existing;
  }

  const visit =
    (encounter.identifier || []).find(function (id) {
      return (id.system || '').includes('visit-number');
    })?.value || encounter.id;

  const communication = {
    resourceType: 'Communication',
    identifier: [
      {
        system: EVENT_NOTIFICATION_SYSTEM,
        value: 'discharge-' + encounter.id + '-bot',
      },
      { system: EVENT_PATH_SYSTEM, value: 'bot' },
    ],
    status: 'completed',
    category: [
      {
        coding: [
          {
            system:
              'http://terminology.hl7.org/CodeSystem/communication-category',
            code: 'notification',
            display: 'Notification',
          },
        ],
        text: 'ADT discharge notification',
      },
    ],
    subject: encounter.subject,
    about: [{ reference: 'Encounter/' + encounter.id }],
    sent: new Date().toISOString(),
    payload: [
      {
        contentString:
          '[bot] Discharge notification for visit ' +
          visit +
          '. Stand-in for NOTIF_ADT_DISCHARGE SMS/WhatsApp.',
      },
    ],
  };
  return medplum.createResource(communication);
}

exports.handler = handler;
`.trim();
}

async function ensureBot(c, accessToken) {
  // Reuse an existing spike bot if present (Medplum ignores client-assigned ids on POST).
  const existing = await search(c, accessToken, 'Bot', {
    name: BOT_NAME,
    _count: '20',
    _sort: '-_lastUpdated',
  });
  let bot = existing.entry?.[0]?.resource;

  if (bot) {
    bot = await fhir(c, accessToken, 'PUT', `Bot/${bot.id}`, {
      ...bot,
      name: BOT_NAME,
      description:
        'Event-driven spike — writes Communication on Encounter.status=finished',
      runtimeVersion: 'vmcontext',
      // Run as the Encounter author (Sunbird ClientApplication), which already
      // has ProjectMembership — avoids the "membership for bot" footgun.
      runAsUser: true,
    });
    console.log(`Reusing Bot/${bot.id} (runAsUser=true)`);
  } else {
    bot = await fhir(c, accessToken, 'POST', 'Bot', {
      resourceType: 'Bot',
      name: BOT_NAME,
      description:
        'Event-driven spike — writes Communication on Encounter.status=finished',
      runtimeVersion: 'vmcontext',
      runAsUser: true,
    });
    console.log(`Created Bot/${bot.id} (runAsUser=true)`);
  }

  await fhir(c, accessToken, 'POST', `Bot/${bot.id}/$deploy`, {
    filename: 'discharge-notification.ts',
    code: botSource(),
  });
  console.log(`Deployed Bot/${bot.id} (vmcontext)`);
  return bot;
}

async function deactivateStaleSubscriptions(c, accessToken) {
  const bundle = await search(c, accessToken, 'Subscription', {
    status: 'active',
    _count: '50',
  });
  for (const entry of bundle.entry ?? []) {
    const sub = entry.resource;
    if (!sub?.id || !sub.reason?.startsWith('Spike:')) continue;
    await fhir(c, accessToken, 'PUT', `Subscription/${sub.id}`, {
      ...sub,
      status: 'off',
    });
    console.log(`Deactivated Subscription/${sub.id}`);
  }
}

async function ensureSubscription(c, accessToken, reason, channel) {
  const body = {
    resourceType: 'Subscription',
    status: 'active',
    reason,
    criteria: 'Encounter',
    channel: {
      ...channel,
      payload: 'application/fhir+json',
    },
  };
  const created = await fhir(c, accessToken, 'POST', 'Subscription', body);
  console.log(`Created Subscription/${created.id} → ${channel.endpoint}`);
  return created;
}

async function provisionTenant(c, tenantId, tenant) {
  // Project Admin client of this tenant: provisioning only. Bots and
  // Subscriptions are Project configuration, which On-Behalf-Of users cannot
  // write.
  const accessToken = await lib.getToken(
    c.baseUrl,
    tenant.clientId,
    tenant.clientSecret,
  );
  const tc = { ...c, projectId: tenant.projectId };
  console.log(`\n== ${tenant.tenantCode} (Project/${tenant.projectId})`);
  const bot = await ensureBot(tc, accessToken);
  await deactivateStaleSubscriptions(tc, accessToken);
  await ensureSubscription(tc, accessToken, SUB_BOT_REASON, {
    type: 'rest-hook',
    endpoint: `Bot/${bot.id}`,
  });
  const webhook = new URL(c.webhookUrl);
  webhook.searchParams.set('tenantId', tenantId);
  await ensureSubscription(tc, accessToken, SUB_BULLMQ_REASON, {
    type: 'rest-hook',
    endpoint: webhook.toString(),
    header: [`X-Sunbird-Subscription-Secret: ${c.secret}`],
  });
}

async function main() {
  const c = cfg();
  const registry = lib.loadRegistry(c.tenantsFile);
  const tenants = Object.entries(registry.tenants);
  if (tenants.length === 0) {
    throw new Error(
      `No tenants in ${c.tenantsFile} - run npm run medplum:up first`,
    );
  }
  for (const [tenantId, tenant] of tenants) {
    await provisionTenant(c, tenantId, tenant);
  }
  console.log(`
Event paths ready for ${tenants.length} tenant(s).
  BullMQ webhook:      ${c.webhookUrl}?tenantId=<tenant>
Enable Nest with EVENTS_ENABLED=true, restart the API, then:
  npm run events:demo
`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
