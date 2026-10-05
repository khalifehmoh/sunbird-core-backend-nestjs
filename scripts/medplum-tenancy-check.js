#!/usr/bin/env node
/**
 * Acceptance check for tenant and branch isolation on the FHIR gateway.
 *
 *   SPIKE_TEST_PASSWORD=... npm run medplum:check
 *
 * Needs the API and Medplum running and the demo data provisioned
 * (npm run medplum:provision && npm run medplum:seed), with the users below
 * able to log in with SPIKE_TEST_PASSWORD. It drives the real HTTP API with
 * real logins, so it exercises the guards, the gateway, Medplum's access
 * policies, and the ADT workflow together.
 *
 * Covers: the five tenant bypasses found in the first spike (conditional PUT,
 * conditional DELETE, $graphql, _include, unchecked references + $everything),
 * branch scoping inside a tenant, permission codes, authorship, and the ADT
 * admit/transfer/discharge flow.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const API = (process.env.API_URL ?? 'http://localhost:8080/api/v1').replace(/\/$/, '');
const PASSWORD = process.env.SPIKE_TEST_PASSWORD;

const USERS = {
  // Tenant A (AR-MED-001), two branches.
  aMain: process.env.USER_A_MAIN ?? 'fatima.hassan@alrajhimedical.sa',
  aNorth: process.env.USER_A_NORTH ?? 'mohammed.alghamdi@alrajhimedical.sa',
  // Tenant A, no PATIENT_MGMT_* codes at all (lab technician).
  lab: process.env.USER_LAB ?? 'khalid.shehri@alrajhimedical.sa',
  // Tenant A, PATIENT_MGMT_CREATE/READ/UPDATE but not DELETE (receptionist).
  receptionist: process.env.USER_RECEPTIONIST ?? 'noura.otaibi@alrajhimedical.sa',
  // Tenant B (KFSH-001).
  bMain: process.env.USER_B_MAIN ?? 'dr.hassan@kfsh.med.sa',
};

const NID_SYSTEM = 'http://nphies.sa/identifier/nationalid';
const RUN = Date.now().toString(36);

const results = [];
const sessions = new Map();

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

async function login(username) {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD, rememberMe: false }),
  });
  if (!response.ok) {
    throw new Error(`login ${username} failed: ${response.status} ${await response.text()}`);
  }
  const cookie = response
    .headers.getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  sessions.set(username, cookie);
}

async function call(username, method, url, body) {
  const response = await fetch(`${API}${url}`, {
    method,
    headers: {
      cookie: sessions.get(username),
      accept: 'application/fhir+json',
      ...(body ? { 'content-type': 'application/fhir+json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

const fhir = (user, method, url, body) => call(user, method, `/fhir/R4/${url}`, body);
const ids = (bundle) => (bundle?.entry ?? []).map((e) => e.resource.id);
const families = (bundle) =>
  (bundle?.entry ?? []).map((e) => e.resource.name?.[0]?.family).filter(Boolean);

function newPatient(family, nationalId) {
  return {
    resourceType: 'Patient',
    identifier: [{ system: NID_SYSTEM, value: nationalId }],
    name: [{ family, given: ['Check'] }],
    gender: 'female',
    birthDate: '1990-01-01',
  };
}

async function main() {
  if (!PASSWORD) {
    throw new Error('Set SPIKE_TEST_PASSWORD to the password of the demo users.');
  }
  const registryFile = path.resolve(ROOT, process.env.MEDPLUM_TENANTS_FILE ?? '.medplum/tenants.json');
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  console.log(`Registry: ${Object.keys(registry.tenants).length} tenant(s)\n`);

  for (const user of new Set(Object.values(USERS))) await login(user);

  // ---- fixtures -----------------------------------------------------------
  const nidB = `9${RUN.replace(/\D/g, '0').padEnd(9, '0').slice(0, 9)}`;
  const bPatient = (await fhir(USERS.bMain, 'POST', 'Patient', newPatient(`TenantB-${RUN}`, nidB))).json;
  const bObs = (
    await fhir(USERS.bMain, 'POST', 'Observation', {
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'check' },
      subject: { reference: `Patient/${bPatient.id}` },
    })
  ).json;
  const northPatient = (await fhir(USERS.aNorth, 'POST', 'Patient', newPatient(`North-${RUN}`, `8${nidB.slice(1)}`))).json;
  const mainPatient = (await fhir(USERS.aMain, 'POST', 'Patient', newPatient(`Main-${RUN}`, `7${nidB.slice(1)}`))).json;
  record(
    'fixtures: B patient, B observation, A-North patient, A-Main patient created through the gateway',
    [bPatient, bObs, northPatient, mainPatient].every((r) => r?.id),
  );

  // ---- 1. the five bypasses from the first spike, as a tenant A user ------
  console.log('\n--- 1. Tenant bypasses (tenant A user vs tenant B data) ---');

  const before = (await fhir(USERS.bMain, 'GET', `Patient/${bPatient.id}`)).json;

  const put = await fhir(USERS.aMain, 'PUT', `Patient?identifier=${NID_SYSTEM}|${nidB}`, newPatient('Hijacked', nidB));
  const afterPut = (await fhir(USERS.bMain, 'GET', `Patient/${bPatient.id}`)).json;
  record(
    '#1 conditional PUT by national id does not overwrite or move tenant B patient',
    afterPut?.name?.[0]?.family === `TenantB-${RUN}` && afterPut?.meta?.versionId === before?.meta?.versionId,
    `PUT -> ${put.status}; B patient family still "${afterPut?.name?.[0]?.family}", version unchanged`,
  );

  const del = await fhir(USERS.aMain, 'DELETE', `Patient?identifier=${NID_SYSTEM}|${nidB}`);
  const afterDel = await fhir(USERS.bMain, 'GET', `Patient/${bPatient.id}`);
  record(
    '#2 conditional DELETE does not delete tenant B patient',
    afterDel.status === 200,
    `DELETE -> ${del.status}; B read -> ${afterDel.status}`,
  );

  const gql = await fhir(USERS.aMain, 'POST', '$graphql', {
    query: '{ PatientList(_count: 1000) { id name { family } } }',
  });
  const gqlIds = (gql.json?.data?.PatientList ?? []).map((p) => p.id);
  record(
    '#3 $graphql returns no tenant B data',
    gql.status === 200 && gqlIds.length > 0 && !gqlIds.includes(bPatient.id),
    `${gqlIds.length} patient(s) visible to A, none is B's`,
  );

  const inc = await fhir(USERS.aMain, 'GET', 'Observation?_include=Observation:subject&_count=200');
  const incAll = JSON.stringify(inc.json ?? {});
  record(
    '#4 _include / _revinclude pulls in no tenant B resource',
    inc.status === 200 && !incAll.includes(bPatient.id) && !incAll.includes(bObs.id),
  );
  const rev = await fhir(USERS.aMain, 'GET', `Patient?_revinclude=Observation:subject&_count=200`);
  record('#4b _revinclude pulls in no tenant B resource', rev.status === 200 && !JSON.stringify(rev.json).includes(bObs.id));

  const plant = await fhir(USERS.aMain, 'POST', 'Observation', {
    resourceType: 'Observation',
    status: 'final',
    code: { text: 'planted' },
    subject: { reference: `Patient/${bPatient.id}` },
  });
  const bObservations = ids((await fhir(USERS.bMain, 'GET', `Observation?subject=Patient/${bPatient.id}&_count=100`)).json);
  record(
    '#5 write referencing a tenant B patient is rejected and plants nothing',
    plant.status === 400 && bObservations.length === 1 && bObservations[0] === bObs.id,
    `POST -> ${plant.status}; B patient still has ${bObservations.length} observation(s)`,
  );
  const everything = await fhir(USERS.aMain, 'GET', `Patient/${bPatient.id}/$everything`);
  const everythingMissing = await fhir(USERS.aMain, 'GET', 'Patient/00000000-0000-4000-8000-000000000000/$everything');
  record(
    '#5b $everything on a tenant B patient is denied and indistinguishable from a nonexistent id',
    [403, 404].includes(everything.status) &&
      everything.status === everythingMissing.status &&
      !JSON.stringify(everything.json ?? {}).includes(nidB),
    `-> ${everything.status} (nonexistent id -> ${everythingMissing.status})`,
  );
  const readB = await fhir(USERS.aMain, 'GET', `Patient/${bPatient.id}`);
  record('control: reading a tenant B patient by id is 404', readB.status === 404, `-> ${readB.status}`);
  const searchB = await fhir(USERS.aMain, 'GET', `Patient?identifier=${NID_SYSTEM}|${nidB}`);
  record('control: searching for a tenant B patient finds nothing', ids(searchB.json).length === 0);

  // ---- 2. branch scope inside tenant A ------------------------------------
  console.log('\n--- 2. Branch scope inside tenant A (MAIN vs NORTH) ---');
  const mainView = (await fhir(USERS.aMain, 'GET', 'Patient?_count=200')).json;
  const northView = (await fhir(USERS.aNorth, 'GET', 'Patient?_count=200')).json;
  record(
    'MAIN user sees the MAIN patient and not the NORTH patient',
    ids(mainView).includes(mainPatient.id) && !ids(mainView).includes(northPatient.id),
    `MAIN sees ${ids(mainView).length}, NORTH sees ${ids(northView).length}`,
  );
  record(
    'NORTH user sees the NORTH patient and not the MAIN patient',
    ids(northView).includes(northPatient.id) && !ids(northView).includes(mainPatient.id),
  );
  record(
    'MAIN and NORTH see disjoint sets of patients',
    ids(mainView).every((id) => !ids(northView).includes(id)),
  );
  const crossRead = await fhir(USERS.aMain, 'GET', `Patient/${northPatient.id}`);
  record('MAIN user reading a NORTH patient by id is 404', crossRead.status === 404, `-> ${crossRead.status}`);
  const gqlMain = await fhir(USERS.aMain, 'POST', '$graphql', {
    query: '{ PatientList(_count: 1000) { id } }',
  });
  const gqlMainIds = (gqlMain.json?.data?.PatientList ?? []).map((p) => p.id);
  record(
    '$graphql for the MAIN user returns MAIN patients only',
    gqlMainIds.includes(mainPatient.id) && !gqlMainIds.includes(northPatient.id),
  );
  const crossEnc = await fhir(USERS.aMain, 'POST', 'Encounter', {
    resourceType: 'Encounter',
    status: 'planned',
    class: { code: 'AMB' },
    subject: { reference: `Patient/${northPatient.id}` },
  });
  record('MAIN user cannot attach an Encounter to a NORTH patient', crossEnc.status === 400, `-> ${crossEnc.status}`);
  const crossCondDelete = await fhir(USERS.aMain, 'DELETE', `Patient?identifier=${NID_SYSTEM}|8${nidB.slice(1)}`);
  const stillThere = await fhir(USERS.aNorth, 'GET', `Patient/${northPatient.id}`);
  record(
    'MAIN conditional DELETE does not delete a NORTH patient',
    stillThere.status === 200,
    `DELETE -> ${crossCondDelete.status}`,
  );

  // ---- 3. permission codes -------------------------------------------------
  console.log('\n--- 3. Permission codes ---');
  const labRead = await fhir(USERS.lab, 'GET', 'Patient');
  record(
    'lab technician (no PATIENT_MGMT_*) cannot read patients',
    labRead.status === 403 && labRead.json?.resourceType === 'OperationOutcome',
    `-> ${labRead.status}`,
  );
  const labGql = await fhir(USERS.lab, 'POST', '$graphql', { query: '{ PatientList { id } }' });
  record('lab technician cannot use $graphql', labGql.status === 403, `-> ${labGql.status}`);
  const labAdt = await call(USERS.lab, 'GET', '/adt/beds');
  record('lab technician cannot read the ADT bed board', labAdt.status === 403, `-> ${labAdt.status}`);
  const recDelete = await fhir(USERS.receptionist, 'DELETE', `Patient/${mainPatient.id}`);
  record('receptionist (no PATIENT_MGMT_DELETE) cannot delete', recDelete.status === 403, `-> ${recDelete.status}`);
  const recRead = await fhir(USERS.receptionist, 'GET', `Patient/${mainPatient.id}`);
  record('receptionist can read within the same branch', recRead.status === 200, `-> ${recRead.status}`);
  const mutation = await fhir(USERS.aMain, 'POST', '$graphql', {
    query: 'mutation { PatientCreate(res: {name: [{family: "x"}]}) { id } }',
  });
  record('GraphQL mutations are refused', mutation.status === 403, `-> ${mutation.status}`);

  // ---- 4. authorship ---------------------------------------------------------
  console.log('\n--- 4. Authorship ---');
  const tenantA = registry.tenants[Object.keys(registry.tenants).find((id) => registry.tenants[id].tenantCode === 'AR-MED-001')];
  const created = (await fhir(USERS.aMain, 'GET', `Patient/${mainPatient.id}`)).json;
  const practitioners = Object.values(tenantA.members).map((m) => `Practitioner/${m.practitionerId}`);
  record(
    "created resource names the Sunbird user's Practitioner in meta.onBehalfOf, not a shared account",
    practitioners.includes(created?.meta?.onBehalfOf?.reference),
    `meta.onBehalfOf = ${created?.meta?.onBehalfOf?.reference} (${created?.meta?.onBehalfOf?.display})`,
  );

  // ---- 5. ADT flow -------------------------------------------------------------
  console.log('\n--- 5. ADT admit -> transfer -> discharge ---');
  const mainBeds = (await call(USERS.aMain, 'GET', '/adt/beds')).json?.locations ?? [];
  const northBeds = (await call(USERS.aNorth, 'GET', '/adt/beds')).json?.locations ?? [];
  const isBed = (l) => l.physicalType === 'bd';
  const isFree = (l) => isBed(l) && !l.occupiedByEncounterId && l.operationalStatus !== 'O';
  const freeMain = mainBeds.filter(isFree);
  record(
    'bed board is per branch: MAIN and NORTH see different locations',
    mainBeds.length > 0 && northBeds.length > 0 && mainBeds.every((l) => !northBeds.some((n) => n.id === l.id)),
    `MAIN ${mainBeds.length} location(s), NORTH ${northBeds.length}`,
  );
  if (freeMain.length < 2) {
    record('ADT flow: two free MAIN beds available', false, `found ${freeMain.length}; reseed with npm run medplum:seed`);
  } else {
    const [bed1, bed2] = freeMain;
    const northBed = northBeds.find(isFree);

    const crossAdmit = await call(USERS.aNorth, 'POST', '/adt/admit', {
      patientId: mainPatient.id,
      bedLocationId: northBed?.id ?? bed1.id,
      admitType: 'routine',
    });
    record('NORTH user cannot admit a MAIN patient', crossAdmit.status === 404, `-> ${crossAdmit.status}`);
    const crossBed = await call(USERS.aMain, 'POST', '/adt/admit', {
      patientId: mainPatient.id,
      bedLocationId: northBed?.id,
      admitType: 'routine',
    });
    record('MAIN user cannot admit into a NORTH bed', crossBed.status === 404, `-> ${crossBed.status}`);

    const admit = await call(USERS.aMain, 'POST', '/adt/admit', {
      patientId: mainPatient.id,
      bedLocationId: bed1.id,
      admitType: 'routine',
    });
    record('admit (A01) succeeds in own branch', admit.status === 201, `-> ${admit.status} ${admit.json?.visitNumber ?? admit.text.slice(0, 120)}`);
    const encounterId = admit.json?.id;

    const dup = await call(USERS.aMain, 'POST', '/adt/admit', { patientId: mainPatient.id, bedLocationId: bed2.id, admitType: 'routine' });
    record('second active admission for the same patient is refused', dup.status === 409, `-> ${dup.status}`);

    const transfer = await call(USERS.aMain, 'POST', '/adt/transfer', { encounterId, bedLocationId: bed2.id, transferReason: 'Spike 5 acceptance check' });
    record('transfer (A02) succeeds', transfer.status === 200, `-> ${transfer.status}`);

    const discharge = await call(USERS.aMain, 'POST', '/adt/discharge', {
      encounterId,
      dischargeDateTime: new Date().toISOString(),
      dischargeDisposition: 'home',
      dischargeCondition: 'stable',
    });
    record('discharge (A03) succeeds', discharge.status === 200, `-> ${discharge.status}`);

    const ownNotifications = await call(USERS.aMain, 'GET', `/events/notifications/${encounterId}`);
    if (ownNotifications.status === 503) {
      console.log('SKIP  event notification isolation (EVENTS_ENABLED is false)');
    } else {
      record('own-branch user can read the encounter notifications', ownNotifications.status === 200, `-> ${ownNotifications.status}`);
      const otherBranch = await call(USERS.aNorth, 'GET', `/events/notifications/${encounterId}`);
      record('other-branch user cannot read them', otherBranch.status === 404, `-> ${otherBranch.status}`);
      const otherTenant = await call(USERS.bMain, 'GET', `/events/notifications/${encounterId}`);
      record('other-tenant user cannot read them', otherTenant.status === 404, `-> ${otherTenant.status}`);
      const noPermission = await call(USERS.lab, 'GET', `/events/notifications/${encounterId}`);
      record('user without PATIENT_MGMT_READ cannot read them', noPermission.status === 403, `-> ${noPermission.status}`);
    }

    const after = (await call(USERS.aMain, 'GET', '/adt/beds')).json?.locations ?? [];
    const stillOccupied = after.filter((l) => l.occupiedByEncounterId === encounterId);
    record('beds are released after discharge', stillOccupied.length === 0);
  }

  // ---- summary -----------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('Failed:');
    failed.forEach((r) => console.log(`  - ${r.name}`));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
