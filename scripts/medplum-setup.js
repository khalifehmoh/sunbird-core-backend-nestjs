#!/usr/bin/env node
/**
 * Provision the local Medplum instance and load demo FHIR data.
 *
 *   npm run medplum:up          start containers, provision, seed (default)
 *   npm run medplum:provision   tenants, branches, memberships only
 *   npm run medplum:seed        demo FHIR data only
 *   npm run medplum:down        stop containers (data volumes are kept)
 *
 * Each Sunbird tenant becomes its own Medplum Project, with a Project Admin
 * service client, an Organization per branch, and one ProjectMembership per
 * user (scoped to that user's branch). The API calls Medplum on behalf of
 * those memberships; see src/fhir/medplum.service.ts. What the API needs to do
 * that (client credentials, membership ids) is written to the registry file
 * (MEDPLUM_TENANTS_FILE, default .medplum/tenants.json, gitignored).
 *
 * Provisioning uses the super-admin ClientApplication that Medplum seeds on
 * first boot from MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_ID/SECRET, and nothing
 * else does. Everything is idempotent: ids are derived from Sunbird ids, so
 * re-running converges on the same state, and memberships of users who are no
 * longer eligible are deleted.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const lib = require('./lib/medplum-admin');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

const NATIONAL_ID_SYSTEM = 'http://nphies.sa/identifier/nationalid';
const IQAMA_SYSTEM = 'http://nphies.sa/identifier/iqama';
const MRN_SYSTEM = 'https://sunbird.health/fhir/mrn';
const DEMO_SYSTEM = 'https://sunbird.health/fhir/demo-seed';
const ORG_SYSTEM = 'https://sunbird.health/fhir/tenant-code';
const IDENTIFIER_TYPE_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/v2-0203';
const MARITAL_STATUS_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus';
const LANGUAGE_EXTENSION_URL =
  'http://hl7.org/fhir/StructureDefinition/language';
const LOCATION_CODE_SYSTEM = 'https://sunbird.health/fhir/location-code';
const VISIT_NUMBER_SYSTEM = 'https://sunbird.health/fhir/visit-number';
const ADT_EVENT_SYSTEM = 'https://sunbird.health/fhir/adt-event';
const LOCATION_PHYSICAL_TYPE_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/location-physical-type';
const LOCATION_STATUS_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/v2-0116';
const LOINC = 'http://loinc.org';
const SNOMED = 'http://snomed.info/sct';
const UCUM = 'http://unitsofmeasure.org';

const MEDPLUM_SERVICES = [
  'medplum-postgres',
  'medplum-redis',
  'medplum-server',
];

// ---------------------------------------------------------------------------
// env handling
// ---------------------------------------------------------------------------

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

/** Adds or updates keys in .env, preserving comments and ordering. */
function writeEnvValues(values) {
  if (!fs.existsSync(ENV_PATH)) {
    console.log('No .env file found; skipping env update.');
    return;
  }
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  const remaining = new Map(Object.entries(values));
  const updated = lines.map((line) => {
    const eq = line.indexOf('=');
    if (line.trim().startsWith('#') || eq === -1) {
      return line;
    }
    const key = line.slice(0, eq).trim();
    if (!remaining.has(key)) {
      return line;
    }
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });

  if (remaining.size > 0) {
    if (updated.at(-1) !== '') {
      updated.push('');
    }
    updated.push('# Medplum FHIR engine (added by npm run medplum:up)');
    for (const [key, value] of remaining) {
      updated.push(`${key}=${value}`);
    }
    updated.push('');
  }

  fs.writeFileSync(ENV_PATH, updated.join('\n'), 'utf8');
  console.log(`Updated ${path.relative(ROOT, ENV_PATH)}`);
}

function config() {
  return {
    baseUrl: (process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/').replace(
      /\/?$/,
      '/',
    ),
    superAdminClientId:
      process.env.MEDPLUM_SUPER_ADMIN_CLIENT_ID ??
      '209d6772-7c4c-46d6-bb98-51fb24d41edb',
    superAdminClientSecret:
      process.env.MEDPLUM_SUPER_ADMIN_CLIENT_SECRET ??
      'f794e61944c87470475dbc1b7546be030d6ba3d71394a733b44d19815979f032',
    registryFile: path.resolve(
      ROOT,
      process.env.MEDPLUM_TENANTS_FILE ?? '.medplum/tenants.json',
    ),
    db: {
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_NAME ?? 'sunbird_core_db',
      user: process.env.DB_USERNAME ?? 'sunbird_app',
      password: process.env.DB_PASSWORD,
    },
  };
}

// ---------------------------------------------------------------------------
// Medplum HTTP helpers
// ---------------------------------------------------------------------------

const getToken = (cfg, clientId, clientSecret) =>
  lib.getToken(cfg.baseUrl, clientId, clientSecret);

const fhir = (cfg, token, method, url, body, options) =>
  lib.fhir(cfg.baseUrl, token, method, url, body, options);

async function waitForHealth(cfg, timeoutMs = 600000) {
  const url = new URL('healthcheck', cfg.baseUrl);
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        if (announced) {
          console.log('');
        }
        return;
      }
    } catch {
      // not listening yet
    }
    if (!announced) {
      process.stdout.write(
        'Waiting for Medplum (first boot seeds FHIR definitions, a few minutes)',
      );
      announced = true;
    }
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Medplum did not become healthy at ${url}`);
}

function compose(args) {
  const result = spawnSync('docker', ['compose', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed`);
  }
}

// ---------------------------------------------------------------------------
// provisioning
// ---------------------------------------------------------------------------

async function provision(cfg) {
  const core = await readCore(cfg);
  if (core.length === 0) {
    console.log(
      'No Sunbird tenants readable from the core database; nothing to provision.\n' +
        'Start Postgres and run `npm run db:setup` first, then `npm run medplum:provision`.',
    );
    return;
  }

  const adminToken = await getToken(
    cfg,
    cfg.superAdminClientId,
    cfg.superAdminClientSecret,
  );
  const registry = lib.loadRegistry(cfg.registryFile);
  registry.tenants ??= {};

  for (const { tenant, branches, users } of core) {
    const { record, skipped, removed } = await lib.provisionTenant({
      baseUrl: cfg.baseUrl,
      adminToken,
      tenant,
      branches,
      users,
      previous: registry.tenants[tenant.tenant_id],
    });
    registry.tenants[tenant.tenant_id] = record;
    // Persist after each tenant so a failure part-way keeps what succeeded.
    lib.saveRegistry(cfg.registryFile, registry);

    const memberCount = Object.keys(record.members).length - 1;
    console.log(
      `${tenant.tenant_code}: Project ${record.projectId}, ` +
        `${branches.length} branch(es), ${memberCount} member(s)`,
    );
    if (skipped.length > 0) {
      console.log(
        `  no clinical access (no valid default branch): ${skipped.join(', ')}`,
      );
    }
    if (removed.length > 0) {
      console.log(`  removed memberships: ${removed.join(', ')}`);
    }

    // Prove the credentials the API will use work and are scoped to the Project.
    const token = await getToken(cfg, record.clientId, record.clientSecret);
    const me = await (
      await fetch(new URL('auth/me', cfg.baseUrl), {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    if (me.project?.id !== record.projectId) {
      throw new Error(
        `Client for ${tenant.tenant_code} resolved to project ${me.project?.id}, expected ${record.projectId}`,
      );
    }
  }
  console.log(`Registry written to ${path.relative(ROOT, cfg.registryFile)}`);
}

// ---------------------------------------------------------------------------
// demo FHIR data
// ---------------------------------------------------------------------------

/** Tenants with their active branches and eligible users, from the core DB. */
async function readCore(cfg) {
  if (!cfg.db.password) {
    return [];
  }
  const client = new Client(cfg.db);
  try {
    await client.connect();
  } catch {
    return [];
  }
  try {
    const tenants = (
      await client.query(
        `SELECT tenant_id, tenant_code, tenant_name, tenant_name_ar, city
           FROM core.tenants
          WHERE is_deleted = FALSE
          ORDER BY tenant_code`,
      )
    ).rows;
    const branches = (
      await client.query(
        `SELECT branch_id, tenant_id, branch_code, branch_name, branch_name_ar,
                is_headquarters
           FROM core.branches
          WHERE is_deleted = FALSE AND status = 'ACTIVE'
          ORDER BY is_headquarters DESC NULLS LAST, branch_code`,
      )
    ).rows;
    const users = (
      await client.query(
        `SELECT user_id, tenant_id, username, first_name, last_name, default_branch_id
           FROM core.users
          WHERE tenant_id IS NOT NULL AND is_deleted = FALSE AND status = 'ACTIVE'
          ORDER BY username`,
      )
    ).rows;
    return tenants.map((tenant) => ({
      tenant,
      branches: branches.filter((b) => b.tenant_id === tenant.tenant_id),
      users: users.filter((u) => u.tenant_id === tenant.tenant_id),
    }));
  } catch {
    return [];
  } finally {
    await client.end();
  }
}

function isoDate(offsetDays) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  return date.toISOString();
}

/**
 * Two `name` entries per patient: Latin and Arabic, the Arabic one carrying the
 * standard `language` extension. Bilingual data is a blueprint requirement and
 * FHIR expects it as repeated elements rather than parallel `*_ar` fields.
 */
function humanNames(person) {
  return [
    {
      use: 'official',
      family: person.family,
      given: person.given,
      text: `${person.given.join(' ')} ${person.family}`,
    },
    {
      use: 'official',
      extension: [{ url: LANGUAGE_EXTENSION_URL, valueCode: 'ar' }],
      family: person.familyAr,
      given: person.givenAr,
      text: `${person.givenAr.join(' ')} ${person.familyAr}`,
    },
  ];
}

function patientResource(person, tenant, orgRef, index) {
  const resident = person.residency === 'resident';
  return {
    resourceType: 'Patient',
    identifier: [
      {
        use: 'official',
        type: {
          coding: [
            {
              system: IDENTIFIER_TYPE_SYSTEM,
              code: resident ? 'PPN' : 'NI',
              display: resident ? 'Passport number' : 'National identifier',
            },
          ],
        },
        system: resident ? IQAMA_SYSTEM : NATIONAL_ID_SYSTEM,
        value: person.nationalId,
      },
      {
        use: 'usual',
        type: {
          coding: [
            {
              system: IDENTIFIER_TYPE_SYSTEM,
              code: 'MR',
              display: 'Medical record number',
            },
          ],
        },
        system: MRN_SYSTEM,
        value: `${tenant.tenant_code}-${String(index + 1).padStart(5, '0')}`,
        assigner: { reference: orgRef, display: tenant.tenant_name },
      },
    ],
    active: true,
    name: humanNames(person),
    telecom: [
      { system: 'phone', value: person.phone, use: 'mobile' },
      { system: 'email', value: person.email, use: 'home' },
    ],
    gender: person.gender,
    birthDate: person.birthDate,
    maritalStatus: {
      coding: [
        {
          system: MARITAL_STATUS_SYSTEM,
          code: person.maritalStatus,
          display: person.maritalStatusDisplay,
        },
      ],
    },
    address: [
      {
        use: 'home',
        type: 'physical',
        line: [person.street],
        city: tenant.city ?? 'Riyadh',
        country: 'SA',
      },
    ],
    communication: [
      {
        language: {
          coding: [
            { system: 'urn:ietf:bcp:47', code: 'ar', display: 'Arabic' },
          ],
        },
        preferred: true,
      },
    ],
    managingOrganization: { reference: orgRef, display: tenant.tenant_name },
  };
}

function vitalSign({ code, display, value, unit, ucum, patientUrn }) {
  return {
    resourceType: 'Observation',
    status: 'final',
    category: [
      {
        coding: [
          {
            system:
              'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'vital-signs',
            display: 'Vital Signs',
          },
        ],
      },
    ],
    code: { coding: [{ system: LOINC, code, display }], text: display },
    subject: { reference: patientUrn },
    effectiveDateTime: isoDate(-1),
    valueQuantity: { value, unit, system: UCUM, code: ucum },
  };
}

function bloodPressure(patientUrn, systolic, diastolic) {
  return {
    resourceType: 'Observation',
    status: 'final',
    category: [
      {
        coding: [
          {
            system:
              'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'vital-signs',
            display: 'Vital Signs',
          },
        ],
      },
    ],
    code: {
      coding: [
        { system: LOINC, code: '85354-9', display: 'Blood pressure panel' },
      ],
      text: 'Blood pressure',
    },
    subject: { reference: patientUrn },
    effectiveDateTime: isoDate(-1),
    // A BP panel carries no top-level value; the readings are components.
    component: [
      {
        code: {
          coding: [
            { system: LOINC, code: '8480-6', display: 'Systolic blood pressure' },
          ],
        },
        valueQuantity: {
          value: systolic,
          unit: 'mm[Hg]',
          system: UCUM,
          code: 'mm[Hg]',
        },
      },
      {
        code: {
          coding: [
            {
              system: LOINC,
              code: '8462-4',
              display: 'Diastolic blood pressure',
            },
          ],
        },
        valueQuantity: {
          value: diastolic,
          unit: 'mm[Hg]',
          system: UCUM,
          code: 'mm[Hg]',
        },
      },
    ],
  };
}

/** The first branch gets the full demo set, others a smaller, distinct one. */
function branchPeople(branchIndex) {
  const people = demoPeople();
  if (branchIndex === 0) return people;
  return people.slice(0, 2).map((person) => ({
    ...person,
    nationalId: String(Number(person.nationalId) + branchIndex),
  }));
}

function demoPeople() {
  return [
    {
      key: 'fatima-alqahtani',
      family: 'Al Qahtani',
      given: ['Fatima', 'Abdullah'],
      familyAr: 'القحطاني',
      givenAr: ['فاطمة', 'عبدالله'],
      gender: 'female',
      birthDate: '1986-04-12',
      nationalId: '1054327890',
      residency: 'citizen',
      phone: '+966501234567',
      email: 'fatima.alqahtani@example.sa',
      street: 'Al Olaya District, King Fahd Road',
      maritalStatus: 'M',
      maritalStatusDisplay: 'Married',
      vitals: { bp: [128, 82], hr: 74, temp: 36.8, weight: 68, height: 162 },
      conditions: [
        { code: '44054006', display: 'Type 2 diabetes mellitus', onset: '2019-06-01' },
      ],
      allergies: [
        { code: '373270004', display: 'Penicillin', criticality: 'high' },
      ],
      encounter: { class: 'AMB', display: 'ambulatory', status: 'finished' },
    },
    {
      key: 'mohammed-alharbi',
      family: 'Al Harbi',
      given: ['Mohammed', 'Saleh'],
      familyAr: 'الحربي',
      givenAr: ['محمد', 'صالح'],
      gender: 'male',
      birthDate: '1972-11-03',
      nationalId: '1098765432',
      residency: 'citizen',
      phone: '+966555987654',
      email: 'm.alharbi@example.sa',
      street: 'Al Malaz District, Salahuddin Road',
      maritalStatus: 'M',
      maritalStatusDisplay: 'Married',
      vitals: { bp: [146, 94], hr: 88, temp: 37.1, weight: 91, height: 175 },
      conditions: [
        { code: '38341003', display: 'Hypertensive disorder', onset: '2015-02-20' },
      ],
      allergies: [],
      encounter: { class: 'IMP', display: 'inpatient encounter', status: 'in-progress' },
    },
    {
      key: 'aisha-rahman',
      family: 'Rahman',
      given: ['Aisha'],
      familyAr: 'رحمن',
      givenAr: ['عائشة'],
      gender: 'female',
      birthDate: '1995-08-21',
      nationalId: '2345678901',
      residency: 'resident',
      phone: '+966533112244',
      email: 'aisha.rahman@example.sa',
      street: 'Al Muruj District, Prince Turki Road',
      maritalStatus: 'S',
      maritalStatusDisplay: 'Never Married',
      vitals: { bp: [112, 70], hr: 66, temp: 36.6, weight: 57, height: 158 },
      conditions: [],
      allergies: [
        { code: '256259004', display: 'Pollen', criticality: 'low' },
      ],
      encounter: { class: 'AMB', display: 'ambulatory', status: 'finished' },
    },
  ];
}

/**
 * One entry in a transaction bundle, as a FHIR conditional update: `PUT
 * Patient?identifier=x` creates the patient when the search matches nothing and
 * updates it when it matches one. That makes the seed declarative — re-running
 * it converges on the same state instead of duplicating or skipping.
 */
function entryFor(fullUrl, resource, conditionalUrl) {
  return { fullUrl, resource, request: { method: 'PUT', url: conditionalUrl } };
}

/**
 * One FHIR transaction per tenant.
 *
 * `fullUrl` values must be `urn:uuid:` with a real UUID: that is the only form
 * Medplum treats as a placeholder to resolve, so a readable slug there would be
 * stored verbatim and leave the references dangling.
 */
function seedBundle(baseTenant, branch) {
  // Identifiers are keyed on tenant_code; give every branch its own so the
  // conditional updates of one branch never match another branch's records.
  const tenant =
    branch.index === 0
      ? baseTenant
      : {
          ...baseTenant,
          tenant_code: `${baseTenant.tenant_code}-${branch.code}`,
        };
  const orgRef = `Organization/${branch.organizationId}`;
  const practitionerUrn = `urn:uuid:${randomUUID()}`;
  const wardMedUrn = `urn:uuid:${randomUUID()}`;
  const wardSurgUrn = `urn:uuid:${randomUUID()}`;
  const clinicOpdUrn = `urn:uuid:${randomUUID()}`;
  const edUrn = `urn:uuid:${randomUUID()}`;

  const beds = [];
  const rooms = [];
  function addWardRooms(wardUrn, wardCode, roomCount) {
    for (let room = 1; room <= roomCount; room += 1) {
      const roomUrn = `urn:uuid:${randomUUID()}`;
      const roomCode = `${wardCode}-RM-${String(room).padStart(2, '0')}`;
      rooms.push({ wardUrn, roomUrn, roomCode });
      for (const bedLetter of ['A', 'B']) {
        beds.push({
          roomUrn,
          bedUrn: `urn:uuid:${randomUUID()}`,
          bedCode: `${roomCode}-BED-${bedLetter}`,
          occupied: false,
        });
      }
    }
  }
  addWardRooms(wardMedUrn, 'WARD-MED-A', 2);
  addWardRooms(wardSurgUrn, 'WARD-SURG-A', 1);
  beds[0].occupied = true;

  const entry = [
    entryFor(
      practitionerUrn,
      {
        resourceType: 'Practitioner',
        identifier: [
          {
            system: DEMO_SYSTEM,
            value: `prac-${tenant.tenant_code}-attending`,
          },
        ],
        active: true,
        name: [
          {
            use: 'official',
            family: 'Alharbi',
            given: ['Mohammed'],
            prefix: ['Dr'],
            text: 'Dr. Mohammed Alharbi',
          },
        ],
      },
      `Practitioner?identifier=${DEMO_SYSTEM}|prac-${tenant.tenant_code}-attending`,
    ),
  ];

  function pushLocation(urn, code, name, physicalType, physicalDisplay, partOfUrn, occupied) {
    // Include tenant_code so conditional updates do not collide across tenants.
    const scopedCode = `${tenant.tenant_code}:${code}`;
    entry.push(
      entryFor(
        urn,
        {
          resourceType: 'Location',
          identifier: [{ system: LOCATION_CODE_SYSTEM, value: scopedCode }],
          status: 'active',
          name,
          mode: 'instance',
          physicalType: {
            coding: [
              {
                system: LOCATION_PHYSICAL_TYPE_SYSTEM,
                code: physicalType,
                display: physicalDisplay,
              },
            ],
            text: physicalDisplay,
          },
          alias: [code],
          managingOrganization: { reference: orgRef },
          ...(partOfUrn ? { partOf: { reference: partOfUrn } } : {}),
          ...(physicalType === 'bd'
            ? {
                operationalStatus: {
                  system: LOCATION_STATUS_SYSTEM,
                  code: occupied ? 'O' : 'U',
                  display: occupied ? 'Occupied' : 'Unoccupied',
                },
              }
            : {}),
        },
        `Location?identifier=${LOCATION_CODE_SYSTEM}|${scopedCode}`,
      ),
    );
  }

  pushLocation(wardMedUrn, 'WARD-MED-A', 'Medical Ward A', 'wa', 'Ward');
  pushLocation(wardSurgUrn, 'WARD-SURG-A', 'Surgical Ward A', 'wa', 'Ward');
  pushLocation(clinicOpdUrn, 'CLINIC-OPD01', 'Outpatient Clinic 01', 'wi', 'Wing');
  pushLocation(edUrn, 'ED', 'Emergency Department', 'wi', 'Wing');
  for (const room of rooms) {
    pushLocation(room.roomUrn, room.roomCode, room.roomCode, 'ro', 'Room', room.wardUrn);
  }
  for (const bed of beds) {
    pushLocation(
      bed.bedUrn,
      bed.bedCode,
      bed.bedCode,
      'bd',
      'Bed',
      bed.roomUrn,
      bed.occupied,
    );
  }

  branchPeople(branch.index).forEach((person, index) => {
    const patientUrn = `urn:uuid:${randomUUID()}`;
    const encounterUrn = `urn:uuid:${randomUUID()}`;
    const demoId = `${tenant.tenant_code}-${person.key}`;
    const mrn = `${tenant.tenant_code}-${String(index + 1).padStart(5, '0')}`;
    const isInpatient = index === 0;
    const isOpd = index === 1;
    const encounterStart = isoDate(-2);
    const visitNumber = isInpatient
      ? `IP-2026-${String(index + 1).padStart(5, '0')}`
      : isOpd
        ? `OP-2026-${String(index + 1).padStart(5, '0')}`
        : `ED-2026-${String(index + 1).padStart(5, '0')}`;

    entry.push(
      entryFor(
        patientUrn,
        patientResource(person, tenant, orgRef, index),
        `Patient?identifier=${MRN_SYSTEM}|${mrn}`,
      ),
    );

    entry.push(
      entryFor(
        encounterUrn,
        {
          resourceType: 'Encounter',
          meta: {
            tag: [
              {
                system: ADT_EVENT_SYSTEM,
                code: isInpatient ? 'A01' : 'A04',
              },
            ],
          },
          identifier: [
            { system: DEMO_SYSTEM, value: `enc-${demoId}` },
            { system: VISIT_NUMBER_SYSTEM, value: visitNumber },
          ],
          status: isInpatient
            ? 'in-progress'
            : person.encounter.status === 'finished'
              ? 'finished'
              : 'in-progress',
          class: {
            system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
            code: isInpatient ? 'IMP' : isOpd ? 'AMB' : 'EMER',
            display: isInpatient
              ? 'inpatient encounter'
              : isOpd
                ? 'ambulatory'
                : 'emergency',
          },
          subject: { reference: patientUrn },
          participant: [
            {
              type: [
                {
                  coding: [
                    {
                      system:
                        'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
                      code: 'ATND',
                      display: 'attender',
                    },
                  ],
                },
              ],
              individual: {
                reference: practitionerUrn,
                display: 'Dr. Mohammed Alharbi',
              },
            },
          ],
          serviceProvider: { reference: orgRef },
          period: { start: encounterStart },
          location: [
            {
              location: {
                reference: isInpatient
                  ? beds[0].bedUrn
                  : isOpd
                    ? clinicOpdUrn
                    : edUrn,
                display: isInpatient
                  ? beds[0].bedCode
                  : isOpd
                    ? 'CLINIC-OPD01'
                    : 'ED',
              },
              status: 'active',
              period: { start: encounterStart },
            },
          ],
        },
        `Encounter?identifier=${DEMO_SYSTEM}|enc-${demoId}`,
      ),
    );

    const observations = [
      bloodPressure(patientUrn, ...person.vitals.bp),
      vitalSign({
        code: '8867-4',
        display: 'Heart rate',
        value: person.vitals.hr,
        unit: '/min',
        ucum: '/min',
        patientUrn,
      }),
      vitalSign({
        code: '8310-5',
        display: 'Body temperature',
        value: person.vitals.temp,
        unit: 'Cel',
        ucum: 'Cel',
        patientUrn,
      }),
      vitalSign({
        code: '29463-7',
        display: 'Body weight',
        value: person.vitals.weight,
        unit: 'kg',
        ucum: 'kg',
        patientUrn,
      }),
      vitalSign({
        code: '8302-2',
        display: 'Body height',
        value: person.vitals.height,
        unit: 'cm',
        ucum: 'cm',
        patientUrn,
      }),
    ];

    observations.forEach((observation, position) => {
      const value = `obs-${demoId}-${position}`;
      entry.push(
        entryFor(
          `urn:uuid:${randomUUID()}`,
          {
            ...observation,
            identifier: [{ system: DEMO_SYSTEM, value }],
            encounter: { reference: encounterUrn },
          },
          `Observation?identifier=${DEMO_SYSTEM}|${value}`,
        ),
      );
    });

    person.conditions.forEach((condition, position) => {
      const value = `cond-${demoId}-${position}`;
      entry.push(
        entryFor(
          `urn:uuid:${randomUUID()}`,
          {
            resourceType: 'Condition',
            identifier: [{ system: DEMO_SYSTEM, value }],
            clinicalStatus: {
              coding: [
                {
                  system:
                    'http://terminology.hl7.org/CodeSystem/condition-clinical',
                  code: 'active',
                  display: 'Active',
                },
              ],
            },
            verificationStatus: {
              coding: [
                {
                  system:
                    'http://terminology.hl7.org/CodeSystem/condition-ver-status',
                  code: 'confirmed',
                  display: 'Confirmed',
                },
              ],
            },
            category: [
              {
                coding: [
                  {
                    system:
                      'http://terminology.hl7.org/CodeSystem/condition-category',
                    code: 'problem-list-item',
                    display: 'Problem List Item',
                  },
                ],
              },
            ],
            code: {
              coding: [
                {
                  system: SNOMED,
                  code: condition.code,
                  display: condition.display,
                },
              ],
              text: condition.display,
            },
            subject: { reference: patientUrn },
            onsetDateTime: condition.onset,
          },
          `Condition?identifier=${DEMO_SYSTEM}|${value}`,
        ),
      );
    });

    person.allergies.forEach((allergy, position) => {
      const value = `allergy-${demoId}-${position}`;
      entry.push(
        entryFor(
          `urn:uuid:${randomUUID()}`,
          {
            resourceType: 'AllergyIntolerance',
            identifier: [{ system: DEMO_SYSTEM, value }],
            clinicalStatus: {
              coding: [
                {
                  system:
                    'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
                  code: 'active',
                  display: 'Active',
                },
              ],
            },
            verificationStatus: {
              coding: [
                {
                  system:
                    'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
                  code: 'confirmed',
                  display: 'Confirmed',
                },
              ],
            },
            criticality: allergy.criticality,
            code: {
              coding: [
                {
                  system: SNOMED,
                  code: allergy.code,
                  display: allergy.display,
                },
              ],
              text: allergy.display,
            },
            patient: { reference: patientUrn },
          },
          `AllergyIntolerance?identifier=${DEMO_SYSTEM}|${value}`,
        ),
      );
    });
  });

  // Stamp the branch onto everything, so a member scoped to another branch
  // cannot see it. Writing meta.accounts needs a project admin in extended mode.
  const account = { reference: orgRef };
  for (const item of entry) {
    item.resource.meta = {
      ...item.resource.meta,
      account,
      accounts: [account],
    };
  }

  return { resourceType: 'Bundle', type: 'transaction', entry };
}


function summarize(bundle) {
  const counts = new Map();
  for (const entry of bundle.entry ?? []) {
    const status = entry.response?.status ?? '?';
    const type = entry.response?.location?.split('/')[0] ?? 'unknown';
    const key = `${type} ${status.startsWith('201') ? 'created' : 'updated'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => `${count} ${key}`)
    .join(', ');
}

async function seed(cfg) {
  const registry = lib.loadRegistry(cfg.registryFile);
  const core = await readCore(cfg);
  const provisioned = core.filter(({ tenant }) => registry.tenants?.[tenant.tenant_id]);
  if (provisioned.length === 0) {
    console.log(
      'No provisioned tenants found; skipping FHIR seed.\n' +
        'Run `npm run medplum:provision` first, then `npm run medplum:seed`.',
    );
    return;
  }

  for (const { tenant, branches } of provisioned) {
    const record = registry.tenants[tenant.tenant_id];
    // The tenant's own Project Admin client: seeding is an administrative act
    // inside one Project, and nothing here can reach another tenant.
    const token = await getToken(cfg, record.clientId, record.clientSecret);
    for (const [index, branch] of branches.entries()) {
      const result = await fhir(
        cfg,
        token,
        'POST',
        '',
        seedBundle(tenant, {
          index,
          code: branch.branch_code,
          organizationId: record.branches[branch.branch_id],
        }),
        { extended: true },
      );
      console.log(
        `${tenant.tenant_code}/${branch.branch_code}: ${summarize(result)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function usage() {
  console.log(`Usage: node scripts/medplum-setup.js [up|provision|seed|down]

  up         Start Medplum containers, provision, and seed demo data (default)
  provision  Create a Project, service client, branches and memberships per tenant
  seed       Load demo FHIR resources into every provisioned tenant, per branch
  down       Stop the Medplum containers (data volumes are kept)`);
}

async function main() {
  loadEnvFile(ENV_PATH);
  const command = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'up';

  if (['help', '-h', '--help'].includes(command)) {
    usage();
    return;
  }

  const cfg = config();

  if (command === 'down') {
    compose(['stop', ...MEDPLUM_SERVICES]);
    return;
  }

  if (!['up', 'provision', 'seed'].includes(command)) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (command === 'up') {
    compose(['up', '-d', 'medplum-server']);
  }

  await waitForHealth(cfg);

  if (command === 'up' || command === 'provision') {
    await provision(cfg);
  }

  if (command === 'up' || command === 'seed') {
    await seed(cfg);
  }

  if (command === 'up') {
    writeEnvValues({
      MEDPLUM_ENABLED: 'true',
      MEDPLUM_BASE_URL: cfg.baseUrl,
      MEDPLUM_TENANTS_FILE: path.relative(ROOT, cfg.registryFile),
    });
    console.log(
      `\nMedplum is ready at ${cfg.baseUrl}\n` +
        'FHIR reaches the browser through this API at /api/v1/fhir/R4.\n' +
        'Restart the API (npm run start:dev) to pick up the new .env values.\n' +
        'Run `npm run medplum:provision` again after adding users or branches.',
    );
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
