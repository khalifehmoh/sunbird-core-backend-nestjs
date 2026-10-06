import {
  Live,
  describeLive,
  eventually,
  registerPatient,
  startLive,
  uniqueMobile,
} from './helpers';

type Worklist = {
  items: { id: string; mrn: string; name: string }[];
  counts: Record<string, number>;
};

describeLive('Patients (live Medplum)', () => {
  let live: Live;

  beforeAll(async () => {
    live = await startLive();
  });

  afterAll(async () => {
    await live?.app.close();
  });

  it('registers a patient with a server-assigned MRN', async () => {
    const patient = await registerPatient(live);

    expect(patient.mrn).toMatch(/^AR-MED-001-\d{5,}$/);
    expect(patient.name).toContain(live.runTag);
  });

  it('finds the patient by MRN, by name and by mobile', async () => {
    const patient = await registerPatient(live);
    const search = async (q: string) =>
      (await live.admin.get('/api/v1/emr/patients').query({ q }).expect(200))
        .body as Worklist;

    // Regression: an MRN with a hyphenated tenant code used to be searched as a name.
    expect((await search(patient.mrn)).items.map((p) => p.id)).toEqual([
      patient.id,
    ]);
    expect((await search(patient.mrn.toLowerCase())).items).toHaveLength(1);
    expect((await search(patient.name)).items.map((p) => p.id)).toContain(
      patient.id,
    );
    expect((await search(patient.mobile)).items.map((p) => p.id)).toContain(
      patient.id,
    );
  });

  it('returns filter counts and honours every worklist filter', async () => {
    const patient = await registerPatient(live);

    for (const filter of ['all', 'inpatient', 'opd', 'ed', 'critical']) {
      const response = await live.admin
        .get('/api/v1/emr/patients')
        .query({ filter })
        .expect(200);
      const body = response.body as Worklist;
      expect(Array.isArray(body.items)).toBe(true);
      for (const key of ['all', 'inpatient', 'opd', 'ed', 'critical']) {
        expect(typeof body.counts[key]).toBe('number');
      }
    }
    // A patient with no encounter is in "all" only.
    const inpatients = (
      await live.admin
        .get('/api/v1/emr/patients')
        .query({ filter: 'inpatient', q: patient.mrn })
        .expect(200)
    ).body as Worklist;
    expect(inpatients.items).toHaveLength(0);
  });

  it('opens the overview and lists encounters', async () => {
    const patient = await registerPatient(live);

    const overview = await live.admin
      .get(`/api/v1/emr/patients/${patient.id}/overview`)
      .expect(200);
    expect(overview.body).toMatchObject({
      patient: {
        id: patient.id,
        mrn: patient.mrn,
        nationalId: patient.nationalId,
      },
      activeEncounter: null,
      counts: { encounters: 0, orders: 0, results: 0 },
    });

    const encounters = await live.admin
      .get(`/api/v1/emr/patients/${patient.id}/encounters`)
      .expect(200);
    expect(encounters.body).toEqual({ items: [] });
  });

  it('rejects a duplicate national id with the existing MRN', async () => {
    const patient = await registerPatient(live);

    const duplicate = await live.admin
      .post('/api/v1/emr/patients')
      .send({
        firstName: live.runTag,
        lastName: 'Copy',
        gender: 'female',
        birthDate: '1991-01-01',
        nationalId: patient.nationalId,
      })
      .expect(409);
    expect((duplicate.body as { message: string }).message).toContain(
      patient.mrn,
    );
  });

  it('validates registration input', async () => {
    const response = await live.admin
      .post('/api/v1/emr/patients')
      .send({
        firstName: '',
        lastName: 'x',
        gender: 'robot',
        birthDate: '2999-01-01',
        nationalId: '123',
        mobile: 'abc',
      })
      .expect(400);

    const errors = (response.body as { errors: Record<string, string> }).errors;
    for (const field of ['firstName', 'gender', 'nationalId', 'mobile']) {
      expect(typeof errors[field]).toBe('string');
    }
  });

  it('records an audit trail starting with the creation', async () => {
    const patient = await registerPatient(live);

    const audit = await live.admin
      .get(`/api/v1/emr/patients/${patient.id}/audit`)
      .expect(200);
    const body = audit.body as {
      patient: { id: string };
      versions: { kind: string; changes: { path: string }[] }[];
    };
    expect(body.patient.id).toBe(patient.id);
    expect(body.versions[0].kind).toBe('created');
    expect(body.versions[0].changes.map((change) => change.path)).toContain(
      'birthDate',
    );
  });

  it('queues a welcome SMS for the new patient', async () => {
    const mobile = uniqueMobile();
    const patient = await registerPatient(live, { mobile });

    const row = await eventually(async () => {
      const log = await live.admin
        .get('/api/v1/emr/notifications')
        .query({ eventCode: 'NOTIF_PATIENT_WELCOME', limit: 100 })
        .expect(200);
      return (
        log.body as {
          items: { patientId: string; recipient: string; status: string }[];
        }
      ).items.find((item) => item.patientId === patient.id);
    });

    expect(row.recipient).toBe(mobile);
    expect(['SENT', 'PENDING']).toContain(row.status);
  });

  it('reads a patient only inside its own tenant', async () => {
    const response = await live.admin
      .get('/api/v1/emr/patients/00000000-0000-4000-8000-000000000000/overview')
      .expect(404);
    expect(response.body).toMatchObject({ status: 404 });
  });

  it('requires a session and the PATIENT_MGMT permissions', async () => {
    await live.anonymous().get('/api/v1/emr/patients').expect(401);
    await live.anonymous().post('/api/v1/emr/patients').send({}).expect(401);

    const limited = await live.limitedUser();
    const denied = await limited.get('/api/v1/emr/patients').expect(403);
    expect((denied.body as { message: string }).message).toContain(
      'PATIENT_MGMT_READ',
    );
    await limited
      .post('/api/v1/emr/patients')
      .send({
        firstName: 'No',
        lastName: 'Access',
        gender: 'male',
        birthDate: '1990-01-01',
      })
      .expect(403);
  });
});
