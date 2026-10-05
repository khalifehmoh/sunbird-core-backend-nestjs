/**
 * End-to-end demo: discharge an inpatient Encounter and wait for both event
 * paths (Medplum Bot + BullMQ) to write a Communication.
 *
 * Prerequisites: Medplum up, `npm run medplum:events`, API with EVENTS_ENABLED=true.
 */
const API = process.env.API_BASE ?? 'http://localhost:8080/api/v1';

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.DEMO_USERNAME ?? 'admin@alrajhimedical.sa',
      password: process.env.DEMO_PASSWORD ?? 'Sunbird@Local1',
      rememberMe: false,
    }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

async function json(cookie, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      cookie,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 400)}`);
  }
  return body;
}

async function main() {
  const cookie = await login();
  const beds = await json(cookie, '/adt/beds');
  const free = beds.locations.find(
    (l) => l.physicalType === 'bd' && l.operationalStatus !== 'O',
  );
  const patients = await json(
    cookie,
    '/fhir/R4/Patient?_count=1&_sort=-_lastUpdated',
    { headers: { accept: 'application/fhir+json' } },
  );
  const patientId = patients.entry?.[0]?.resource?.id;
  if (!patientId || !free) {
    throw new Error('Need a patient and a free bed (run medplum:seed)');
  }

  // Clear any active IP for this patient by discharging first if needed.
  const active = await json(
    cookie,
    `/fhir/R4/Encounter?subject=Patient/${patientId}&class=IMP&status=in-progress&_count=5`,
    { headers: { accept: 'application/fhir+json' } },
  );
  for (const entry of active.entry ?? []) {
    const id = entry.resource.id;
    await json(cookie, '/adt/discharge', {
      method: 'POST',
      body: JSON.stringify({
        encounterId: id,
        dischargeDateTime: new Date().toISOString(),
        dischargeDisposition: 'home',
        dischargeCondition: 'improved',
      }),
    }).catch(() => undefined);
  }

  const admitted = await json(cookie, '/adt/admit', {
    method: 'POST',
    body: JSON.stringify({
      patientId,
      admitType: 'routine',
      bedLocationId: free.id,
      hospitalService: 'Medicine',
    }),
  });
  console.log('admitted', admitted.visitNumber, admitted.id);

  const discharged = await json(cookie, '/adt/discharge', {
    method: 'POST',
    body: JSON.stringify({
      encounterId: admitted.id,
      dischargeDateTime: new Date().toISOString(),
      dischargeDisposition: 'home',
      dischargeCondition: 'improved',
    }),
  });
  console.log('discharged', discharged.visitNumber, discharged.lastAdtEvent);

  let summary;
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    summary = await json(cookie, `/events/notifications/${admitted.id}`);
    console.log(
      `  poll ${i + 1}: bot=${summary.bot} bullmq=${summary.bullmq} count=${summary.items?.length ?? 0}`,
    );
    if (summary.bot && summary.bullmq) break;
  }

  console.log('\nResult:');
  console.log(JSON.stringify(summary, null, 2));
  if (!summary?.bot || !summary?.bullmq) {
    process.exitCode = 1;
    console.error(
      '\nExpected both paths. Check: EVENTS_ENABLED, medplum:events, Redis :6380, host.docker.internal webhook.',
    );
  } else {
    console.log('\nBoth event paths fired — Bot and BullMQ each wrote a Communication.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
