import {
  Live,
  describeLive,
  freeBeds,
  registerPatient,
  startLive,
} from './helpers';

type Diagnosis = {
  id: string;
  patientId: string | null;
  encounterId: string | null;
  type: string | null;
  code: string | null;
  display: string | null;
  verification: string | null;
  notes: string | null;
};

describeLive('Diagnoses (live Medplum)', () => {
  let live: Live;

  beforeAll(async () => {
    live = await startLive();
  });

  afterAll(async () => {
    await live?.app.close();
  });

  async function admitPatient() {
    const patient = await registerPatient(live);
    const [bed] = await freeBeds(live);
    const stay = (
      await live.admin
        .post('/api/v1/adt/admit')
        .send({
          patientId: patient.id,
          admitType: 'routine',
          bedLocationId: bed,
        })
        .expect(201)
    ).body as { id: string };
    return { patient, stay, bed };
  }

  async function discharge(stayId: string) {
    await live.admin
      .post('/api/v1/adt/discharge')
      .send({
        encounterId: stayId,
        dischargeDateTime: new Date().toISOString(),
        dischargeDisposition: 'home',
        dischargeCondition: 'improved',
      })
      .expect(200);
  }

  it('records PRIMARY and WORKING diagnoses against an encounter', async () => {
    const { patient, stay } = await admitPatient();

    const primary = (
      await live.admin
        .post('/api/v1/emr/diagnoses')
        .send({
          patientId: patient.id,
          encounterId: stay.id,
          type: 'PRIMARY',
          code: 'j18.9',
          display: 'Pneumonia, unspecified',
          notes: `${live.runTag} primary`,
        })
        .expect(201)
    ).body as Diagnosis;
    expect(primary).toMatchObject({
      patientId: patient.id,
      encounterId: stay.id,
      type: 'PRIMARY',
      code: 'J18.9',
      display: 'Pneumonia, unspecified',
      verification: 'confirmed',
      notes: `${live.runTag} primary`,
    });

    const working = (
      await live.admin
        .post('/api/v1/emr/diagnoses')
        .send({
          patientId: patient.id,
          encounterId: stay.id,
          type: 'WORKING',
          code: 'R50.9',
          display: 'Fever, unspecified',
        })
        .expect(201)
    ).body as Diagnosis;
    expect(working.verification).toBe('provisional');

    const listed = (
      await live.admin
        .get('/api/v1/emr/diagnoses')
        .query({ patientId: patient.id })
        .expect(200)
    ).body as { items: Diagnosis[] };
    expect(listed.items).toHaveLength(2);

    const primaries = (
      await live.admin
        .get('/api/v1/emr/diagnoses')
        .query({ patientId: patient.id, type: 'PRIMARY' })
        .expect(200)
    ).body as { items: Diagnosis[] };
    expect(primaries.items).toEqual([
      expect.objectContaining({ id: primary.id, type: 'PRIMARY' }),
    ]);

    const overview = await live.admin
      .get(`/api/v1/emr/patients/${patient.id}/overview`)
      .expect(200);
    expect((overview.body as { diagnoses: Diagnosis[] }).diagnoses).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: primary.id })]),
    );

    await discharge(stay.id);
  });

  it('rejects a diagnosis without an encounter of that patient, and a bad ICD-10 code', async () => {
    const { patient, stay } = await admitPatient();
    const other = await registerPatient(live);

    await live.admin
      .post('/api/v1/emr/diagnoses')
      .send({
        patientId: other.id,
        encounterId: stay.id,
        type: 'PRIMARY',
        code: 'J18.9',
        display: 'Pneumonia',
      })
      .expect(400);

    await live.admin
      .post('/api/v1/emr/diagnoses')
      .send({
        patientId: patient.id,
        encounterId: stay.id,
        type: 'PRIMARY',
        code: 'not-a-code',
        display: 'Nope',
      })
      .expect(400);

    await live.admin
      .post('/api/v1/emr/diagnoses')
      .send({
        patientId: patient.id,
        encounterId: stay.id,
        type: 'COMORBID',
        code: 'J18.9',
        display: 'Pneumonia',
      })
      .expect(400);

    await discharge(stay.id);
  });

  it('requires a session and the PATIENT_MGMT permissions', async () => {
    await live.anonymous().get('/api/v1/emr/diagnoses').expect(401);
    const limited = await live.limitedUser();
    await limited.get('/api/v1/emr/diagnoses').expect(403);
    await limited.post('/api/v1/emr/diagnoses').send({}).expect(403);
  });
});
