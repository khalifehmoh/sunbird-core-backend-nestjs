import { Live, describeLive, registerPatient, startLive } from './helpers';

type VitalRow = {
  id: string;
  patientId: string | null;
  code: string;
  loinc: string;
  display: string;
  value: number;
  unit: string;
  flag: string;
  source: string;
};

type VitalsResponse = {
  items: VitalRow[];
  summary: { total: number; critical: number; abnormal: number };
};

describeLive('Vitals (live Medplum)', () => {
  let live: Live;

  beforeAll(async () => {
    live = await startLive();
  });

  afterAll(async () => {
    await live?.app.close();
  });

  it('lists the vital definitions the entry form uses', async () => {
    const response = await live.admin
      .get('/api/v1/emr/vitals/definitions')
      .expect(200);
    const items = response.body as { key: string; loinc: string }[];
    expect(items.map((item) => item.key)).toEqual(
      expect.arrayContaining(['HR', 'RR', 'SPO2', 'TEMP', 'BP_SYS', 'BP_DIA']),
    );
  });

  it('records a set of readings and flags critical and abnormal values', async () => {
    const patient = await registerPatient(live);

    const recorded = (
      await live.admin
        .post('/api/v1/emr/vitals')
        .send({
          patientId: patient.id,
          source: 'MANUAL',
          note: `${live.runTag} triage`,
          readings: [
            { code: 'HR', value: 72 },
            { code: 'TEMP', value: 41.2 },
            { code: 'SPO2', value: 93 },
          ],
        })
        .expect(201)
    ).body as VitalsResponse;

    expect(recorded.summary).toEqual({ total: 3, critical: 1, abnormal: 1 });
    expect(recorded.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'HR',
          value: 72,
          flag: 'normal',
          source: 'MANUAL',
          patientId: patient.id,
        }),
        expect.objectContaining({
          code: 'TEMP',
          value: 41.2,
          flag: 'critical',
          unit: '°C',
        }),
        expect.objectContaining({ code: 'SPO2', value: 93, flag: 'abnormal' }),
      ]),
    );

    const listed = (
      await live.admin
        .get('/api/v1/emr/vitals')
        .query({ patientId: patient.id })
        .expect(200)
    ).body as VitalsResponse;
    expect(listed.items).toHaveLength(3);
    expect(listed.summary.critical).toBe(1);

    const criticalOnly = (
      await live.admin
        .get('/api/v1/emr/vitals')
        .query({ patientId: patient.id, criticalOnly: 'true' })
        .expect(200)
    ).body as VitalsResponse;
    expect(criticalOnly.items).toEqual([
      expect.objectContaining({ code: 'TEMP', flag: 'critical' }),
    ]);
  });

  it('rejects implausible values, duplicates, an unknown code and a future time', async () => {
    const patient = await registerPatient(live);

    const tooHigh = await live.admin
      .post('/api/v1/emr/vitals')
      .send({
        patientId: patient.id,
        readings: [{ code: 'HR', value: 900 }],
      })
      .expect(400);
    expect((tooHigh.body as { message: string }).message).toMatch(/between/i);

    await live.admin
      .post('/api/v1/emr/vitals')
      .send({
        patientId: patient.id,
        readings: [
          { code: 'HR', value: 80 },
          { code: 'HR', value: 90 },
        ],
      })
      .expect(400);

    await live.admin
      .post('/api/v1/emr/vitals')
      .send({
        patientId: patient.id,
        readings: [{ code: 'BMI', value: 22 }],
      })
      .expect(400);

    await live.admin
      .post('/api/v1/emr/vitals')
      .send({
        patientId: patient.id,
        measuredAt: '2999-01-01T00:00:00.000Z',
        readings: [{ code: 'HR', value: 80 }],
      })
      .expect(400);

    await live.admin
      .post('/api/v1/emr/vitals')
      .send({
        patientId: '00000000-0000-4000-8000-000000000000',
        readings: [{ code: 'HR', value: 80 }],
      })
      .expect(404);
  });

  it('requires a session and the PATIENT_MGMT permissions', async () => {
    await live.anonymous().get('/api/v1/emr/vitals').expect(401);
    const limited = await live.limitedUser();
    await limited.get('/api/v1/emr/vitals').expect(403);
    await limited
      .post('/api/v1/emr/vitals')
      .send({
        patientId: '00000000-0000-4000-8000-000000000000',
        readings: [{ code: 'HR', value: 80 }],
      })
      .expect(403);
  });
});
