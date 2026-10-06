#!/usr/bin/env node
/**
 * Plays a small set of HL7 v2 messages against the running API, the way an
 * external lab / HIS / scheduling system would, and prints each ACK.
 *
 *   npm run hl7:simulate -- --mrn AR-MED-001-00003
 *   npm run hl7:simulate -- --mrn AR-MED-001-00003 --provider <practitioner-id>
 *
 * Options (all optional except where noted):
 *   --mrn       patient MRN                     (default AR-MED-001-00003)
 *   --tenant    tenant id (uuid)                (default: demo AR-MED-001 tenant)
 *   --url       API base                        (default http://localhost:$PORT/api/v1)
 *   --key       integration key                 (default INTEGRATION_API_KEY from .env)
 *   --order     existing order number to send a result for, e.g. ORD-2026-00002
 *   --provider  Practitioner id, enables the SIU scheduling messages
 *   --only      orm | oru | siu | bad            run just one group
 *
 * Every run uses fresh control ids, so repeating it creates new records.
 * `bad` sends a message with an unknown MRN to show an AE acknowledgement.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEMO_TENANT_ID = 'a0abd516-c1d0-492b-8bfd-30e60166e749';

function loadEnv() {
  const file = path.resolve(__dirname, '..', '.env');
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trim().startsWith('#')) {
      values[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
  return values;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[name] = 'true';
      } else {
        args[name] = next;
        i += 1;
      }
    }
  }
  return args;
}

const env = loadEnv();
const args = parseArgs(process.argv.slice(2));
const config = {
  mrn: args.mrn ?? 'AR-MED-001-00003',
  tenant: args.tenant ?? process.env.SIMULATE_TENANT_ID ?? DEMO_TENANT_ID,
  base: (
    args.url ??
    `http://localhost:${process.env.PORT ?? env.PORT ?? 8080}/api/v1`
  ).replace(/\/$/, ''),
  key: args.key ?? process.env.INTEGRATION_API_KEY ?? env.INTEGRATION_API_KEY,
  order: args.order,
  provider: args.provider,
  only: args.only,
  dryRun: args['dry-run'] === 'true',
};

const run = Date.now().toString(36).toUpperCase();

/** `YYYYMMDDHHMMSS` in UTC, offset by whole hours/days from now. */
function stamp(offsetHours = 0) {
  const date = new Date(Date.now() + offsetHours * 3_600_000);
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function message(type, segments) {
  const header = `MSH|^~\\&|SIM|HOSP|EMR|HOSP|${stamp()}||${type}|{ID}|P|2.5`;
  return [header, ...segments].join('\r');
}

const pid = (mrn) => `PID|1||${mrn}^^^HOSP^MR||Patient^Simulated||19800101|M`;

function scenarios() {
  const orderNumber = config.order ?? `SIM-${run}-1`;
  const cancelNumber = `SIM-${run}-2`;
  const appointmentId = `SIM-APPT-${run}`;
  // Next working day (Sun-Thu), so the clinic calendar accepts the booking.
  let ahead = 24;
  while ([5, 6].includes(new Date(Date.now() + ahead * 3_600_000).getUTCDay())) {
    ahead += 24;
  }
  const tomorrow = stamp(ahead).slice(0, 8);
  const list = [];

  if (!config.only || config.only === 'orm') {
    if (!config.order) {
      list.push({
        label: 'ORM^O01 NW  new lab order',
        id: `ORM-${run}-1`,
        text: message('ORM^O01', [
          pid(config.mrn),
          `ORC|NW|${orderNumber}`,
          `OBR|1|${orderNumber}||718-7^Hemoglobin^LN||||${stamp(-1)}`,
        ]),
      });
    }
    list.push(
      {
        label: 'ORM^O01 NW  second order (to be cancelled)',
        id: `ORM-${run}-2`,
        text: message('ORM^O01', [
          pid(config.mrn),
          `ORC|NW|${cancelNumber}`,
          `OBR|1|${cancelNumber}||58410-2^CBC panel^LN`,
        ]),
      },
      {
        label: 'ORM^O01 CA  cancel the second order',
        id: `ORM-${run}-3`,
        text: message('ORM^O01', [
          pid(config.mrn),
          ['ORC', 'CA', cancelNumber, ...Array(13).fill(''), 'OE^Ordered in error'].join('|'),
          `OBR|1|${cancelNumber}||58410-2^CBC panel^LN`,
        ]),
      },
    );
  }

  if (!config.only || config.only === 'oru') {
    list.push({
      label: `ORU^R01     critical result for order ${orderNumber}`,
      id: `ORU-${run}-1`,
      text: message('ORU^R01', [
        pid(config.mrn),
        `OBR|1|${orderNumber}||718-7^Hemoglobin^LN|||${stamp(-1)}`,
        'OBX|1|NM|718-7^Hemoglobin^LN||6.1|g/dL|13.5-17.5|LL|||F',
      ]),
    });
    list.push({
      label: `ORU^R01     normal result for the same patient`,
      id: `ORU-${run}-2`,
      text: message('ORU^R01', [
        pid(config.mrn),
        `OBR|1|||2951-2^Sodium^LN|||${stamp(-1)}`,
        'OBX|1|NM|2951-2^Sodium^LN||140|mmol/L|135-145|N|||F',
      ]),
    });
  }

  if (!config.only || config.only === 'siu') {
    if (config.provider) {
      list.push(
        {
          label: 'SIU^S12     book an appointment',
          id: `SIU-${run}-1`,
          text: message('SIU^S12', [
            `SCH|${appointmentId}||||||ROUTINE^Routine check||30|min|^^^${tomorrow}090000`,
            pid(config.mrn),
            `AIP|1||${config.provider}^Provider`,
          ]),
        },
        {
          label: 'SIU^S15     cancel that appointment',
          id: `SIU-${run}-2`,
          text: message('SIU^S15', [
            `SCH|${appointmentId}|||||Patient request^Patient request`,
            pid(config.mrn),
          ]),
        },
      );
    } else if (config.only === 'siu') {
      console.log('SIU needs --provider <Practitioner id>; nothing to send.');
    } else {
      console.log('(skipping SIU: pass --provider <Practitioner id> to include it)\n');
    }
  }

  if (config.only === 'bad') {
    list.push({
      label: 'ORU^R01     unknown patient (expect AE)',
      id: `BAD-${run}`,
      text: message('ORU^R01', [
        pid('NO-SUCH-MRN'),
        `OBR|1|||718-7^Hemoglobin^LN|||${stamp(-1)}`,
        'OBX|1|NM|718-7^Hemoglobin^LN||13.9|g/dL|13.5-17.5|N|||F',
      ]),
    });
  }
  return list;
}

function ackSummary(ack) {
  const msa = ack
    .split(/\r\n|\r|\n/)
    .find((line) => line.startsWith('MSA'))
    ?.split('|');
  return msa ? `${msa[1]}${msa[3] ? ` - ${msa[3]}` : ''}` : ack.slice(0, 120);
}

async function send(scenario) {
  const body = scenario.text.replace('{ID}', scenario.id);
  const response = await fetch(`${config.base}/emr/integration/inbound`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'x-integration-key': config.key,
      'x-tenant-id': config.tenant,
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    return `HTTP ${response.status} ${text.slice(0, 160)}`;
  }
  return `${ackSummary(text)}   (message ${response.headers.get('x-message-id')})`;
}

async function main() {
  if (!config.key) {
    console.error(
      'No integration key. Set INTEGRATION_API_KEY in .env (24+ characters), restart the API, or pass --key.',
    );
    process.exit(1);
  }
  const plan = scenarios();
  if (plan.length === 0) return;
  if (config.dryRun) {
    for (const s of plan) {
      console.log(s.label);
      console.log(s.text.replace('{ID}', s.id).replace(/\r/g, '\n'));
      console.log('');
    }
    return;
  }
  console.log(`Target  ${config.base}`);
  console.log(`Tenant  ${config.tenant}`);
  console.log(`Patient ${config.mrn}\n`);
  let failures = 0;
  for (const scenario of plan) {
    let outcome;
    try {
      outcome = await send(scenario);
    } catch (error) {
      outcome = `request failed: ${error.message}`;
    }
    const ok = outcome.startsWith('AA');
    const expectedError =
      scenario.label.includes('expect AE') && /^A[ER]/.test(outcome);
    if (!ok && !expectedError) failures += 1;
    console.log(`${ok || expectedError ? 'OK  ' : 'FAIL'} ${scenario.label}\n     ${outcome}`);
  }
  console.log(
    failures === 0
      ? '\nDone. Open /emr/integration to see the messages.'
      : `\n${failures} message(s) failed. Open /emr/integration for the reason.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
