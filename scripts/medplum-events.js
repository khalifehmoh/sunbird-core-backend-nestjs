#!/usr/bin/env node
/**
 * Provision the event-driven spike: one Medplum Bot + two Subscriptions that
 * fire on Encounter updates.
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

const BOT_NAME = 'Spike: discharge notification';
const SUB_BOT_REASON = 'Spike: Encounter → Medplum Bot (discharge notification)';
const SUB_BULLMQ_REASON =
  'Spike: Encounter → Nest BullMQ (discharge notification)';
const EVENT_PATH_SYSTEM = 'https://sunbird.health/fhir/event-path';
const EVENT_NOTIFICATION_SYSTEM =
  'https://sunbird.health/fhir/event-notification';

const SUPER_ADMIN_CLIENT_ID =
  process.env.MEDPLUM_SUPER_ADMIN_CLIENT_ID ??
  '209d6772-7c4c-46d6-bb98-51fb24d41edb';
const SUPER_ADMIN_CLIENT_SECRET =
  process.env.MEDPLUM_SUPER_ADMIN_CLIENT_SECRET ??
  'f794e61944c87470475dbc1b7546be030d6ba3d71394a733b44d19815979f032';

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
    clientId: process.env.MEDPLUM_CLIENT_ID,
    clientSecret: process.env.MEDPLUM_CLIENT_SECRET,
    projectId: process.env.MEDPLUM_PROJECT_ID,
    webhookUrl:
      process.env.EVENTS_WEBHOOK_URL ||
      'http://host.docker.internal:8080/api/v1/events/fhir-subscription',
    secret:
      process.env.EVENTS_SUBSCRIPTION_SECRET ||
      'local-subscription-secret-change-me',
  };
}

async function token(c) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: c.clientId,
    client_secret: c.clientSecret,
  });
  const res = await fetch(new URL('oauth2/token', c.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`token failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.access_token;
}

async function adminToken(c) {
  return token({
    ...c,
    clientId: SUPER_ADMIN_CLIENT_ID,
    clientSecret: SUPER_ADMIN_CLIENT_SECRET,
  });
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

  const tenantTags = (encounter.meta && encounter.meta.tag
    ? encounter.meta.tag
    : []
  ).filter(function (t) {
    return (t.system || '').includes('tenant');
  });

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
  if (tenantTags.length) {
    communication.meta = { tag: tenantTags };
  }

  return medplum.createResource(communication);
}

exports.handler = handler;
`.trim();
}

async function enableProjectBots(c) {
  const accessToken = await adminToken(c);
  const project = await fhir(c, accessToken, 'GET', `Project/${c.projectId}`);
  const features = new Set(project.features ?? []);
  features.add('bots');
  await fhir(c, accessToken, 'PUT', `Project/${c.projectId}`, {
    ...project,
    features: [...features],
  });
  console.log(`Project/${c.projectId} features: ${[...features].join(', ')}`);
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

async function main() {
  const c = cfg();
  if (!c.clientId || !c.clientSecret) {
    throw new Error('MEDPLUM_CLIENT_ID/SECRET missing — run npm run medplum:up first');
  }
  const accessToken = await token(c);
  await enableProjectBots(c);
  const bot = await ensureBot(c, accessToken);
  await deactivateStaleSubscriptions(c, accessToken);
  await ensureSubscription(c, accessToken, SUB_BOT_REASON, {
    type: 'rest-hook',
    endpoint: `Bot/${bot.id}`,
  });
  await ensureSubscription(c, accessToken, SUB_BULLMQ_REASON, {
    type: 'rest-hook',
    endpoint: c.webhookUrl,
    header: [`X-Sunbird-Subscription-Secret: ${c.secret}`],
  });
  console.log(`
Event paths ready.
  Bot endpoint:        Bot/${bot.id} (runAsUser)
  BullMQ webhook:      ${c.webhookUrl}
Enable Nest with EVENTS_ENABLED=true, restart the API, then:
  npm run events:demo
`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
