import {
  Live,
  describeLive,
  eventually,
  freeBeds,
  registerPatient,
  startLive,
} from './helpers';

type Encounter = {
  id: string;
  visitNumber: string | null;
  status: string;
  patientClass: string;
  patientId: string | null;
  locationId: string | null;
  locationDisplay: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  lengthOfStayDays: number | null;
  lastAdtEvent: string | null;
};

type Board = {
  locations: {
    id: string;
    physicalType: string;
    occupiedByEncounterId: string | null;
  }[];
};

describeLive('ADT workflows (live Medplum)', () => {
  let live: Live;

  const occupant = async (bedId: string) =>
    (
      (await live.admin.get('/api/v1/adt/beds').expect(200)).body as Board
    ).locations.find((location) => location.id === bedId)
      ?.occupiedByEncounterId;

  beforeAll(async () => {
    live = await startLive();
  });

  afterAll(async () => {
    await live?.app.close();
  });

  describe('inpatient stay: pre-admit, admit, transfer, discharge', () => {
    let patient: Awaited<ReturnType<typeof registerPatient>>;
    let bedA: string;
    let bedB: string;
    let preadmit: Encounter;
    let stay: Encounter;

    beforeAll(async () => {
      patient = await registerPatient(live);
      [bedA, bedB] = await freeBeds(live);
      if (!bedA || !bedB) throw new Error('The live stack needs two free beds');
    });

    it('A05: pre-admits for a future date', async () => {
      const response = await live.admin
        .post('/api/v1/adt/preadmit')
        .send({
          patientId: patient.id,
          plannedStartDate: '2026-12-01',
          plannedProcedure: `${live.runTag} planned procedure`,
        })
        .expect(201);
      preadmit = response.body as Encounter;

      expect(preadmit).toMatchObject({
        status: 'planned',
        patientClass: 'IMP',
        patientId: patient.id,
        lastAdtEvent: 'A05',
      });
      expect(preadmit.visitNumber).toMatch(/^PA-\d{4}-\d+$/);
      // A planned stay holds no bed.
      expect(preadmit.locationId).toBeNull();
    });

    it('A01: converts the pre-admission to an admission, cancelling the plan and occupying the bed', async () => {
      const response = await live.admin
        .post(`/api/v1/adt/preadmit/${preadmit.id}/admit`)
        .send({ admitType: 'elective', bedLocationId: bedA })
        .expect(201);
      stay = response.body as Encounter;

      // The admission is a new encounter; the planned one is closed off.
      expect(stay.id).not.toBe(preadmit.id);
      expect(stay).toMatchObject({
        status: 'in-progress',
        patientClass: 'IMP',
        locationId: bedA,
        lastAdtEvent: 'A01',
      });
      expect(stay.visitNumber).toMatch(/^IP-\d{4}-\d+$/);
      expect(await occupant(bedA)).toBe(stay.id);

      const plan = await live.admin
        .get(`/api/v1/adt/encounters/${preadmit.id}`)
        .expect(200);
      expect((plan.body as Encounter).status).toBe('cancelled');
    });

    it('cannot convert the same pre-admission twice', async () => {
      await live.admin
        .post(`/api/v1/adt/preadmit/${preadmit.id}/admit`)
        .send({ admitType: 'elective', bedLocationId: bedB })
        .expect(400);
    });

    it('reads the encounter back and shows it as the active encounter', async () => {
      const read = await live.admin
        .get(`/api/v1/adt/encounters/${stay.id}`)
        .expect(200);
      expect(read.body).toMatchObject({ id: stay.id, status: 'in-progress' });

      const overview = await live.admin
        .get(`/api/v1/emr/patients/${patient.id}/overview`)
        .expect(200);
      expect(
        (overview.body as { activeEncounter: Encounter }).activeEncounter.id,
      ).toBe(stay.id);

      const worklist = await live.admin
        .get('/api/v1/emr/patients')
        .query({ filter: 'inpatient', q: patient.mrn })
        .expect(200);
      expect(
        (worklist.body as { items: { id: string; patientClass: string }[] })
          .items,
      ).toEqual([
        expect.objectContaining({ id: patient.id, patientClass: 'IMP' }),
      ]);
    });

    it('refuses a second active admission and an occupied bed', async () => {
      const second = await registerPatient(live);

      const again = await live.admin
        .post('/api/v1/adt/admit')
        .send({
          patientId: patient.id,
          admitType: 'routine',
          bedLocationId: bedB,
        })
        .expect(409);
      expect((again.body as { message: string }).message).toMatch(
        /already has an active inpatient encounter/i,
      );

      const occupied = await live.admin
        .post('/api/v1/adt/admit')
        .send({
          patientId: second.id,
          admitType: 'routine',
          bedLocationId: bedA,
        })
        .expect(409);
      expect((occupied.body as { message: string }).message).toMatch(
        /already occupied/i,
      );
      // The refused admission must not have left anything behind.
      expect(await occupant(bedA)).toBe(stay.id);
    });

    it('A02: transfers to another bed, freeing the first', async () => {
      const response = await live.admin
        .post('/api/v1/adt/transfer')
        .send({
          encounterId: stay.id,
          bedLocationId: bedB,
          transferReason: `${live.runTag} closer to the nurses station`,
        })
        .expect(200);

      expect(response.body).toMatchObject({
        id: stay.id,
        status: 'in-progress',
        locationId: bedB,
        lastAdtEvent: 'A02',
      });
      expect(await occupant(bedA)).toBeNull();
      expect(await occupant(bedB)).toBe(stay.id);
    });

    it('requires a transfer reason and a valid encounter id', async () => {
      await live.admin
        .post('/api/v1/adt/transfer')
        .send({ encounterId: stay.id, bedLocationId: bedA })
        .expect(400);
      await live.admin
        .post('/api/v1/adt/transfer')
        .send({
          encounterId: 'not-a-uuid',
          bedLocationId: bedA,
          transferReason: 'x',
        })
        .expect(400);
      await live.admin.get('/api/v1/adt/encounters/not-a-uuid').expect(400);
    });

    it('queues the admit SMS', async () => {
      const row = await eventually(async () => {
        const log = await live.admin
          .get('/api/v1/emr/notifications')
          .query({ eventCode: 'NOTIF_ADT_ADMIT', limit: 100 })
          .expect(200);
        return (
          log.body as { items: { patientId: string; status: string }[] }
        ).items.find((item) => item.patientId === patient.id);
      });
      expect(['SENT', 'PENDING']).toContain(row.status);
    });

    it('A03: discharges, closes the encounter, computes length of stay and frees the bed', async () => {
      const dischargeAt = new Date().toISOString();
      const response = await live.admin
        .post('/api/v1/adt/discharge')
        .send({
          encounterId: stay.id,
          dischargeDateTime: dischargeAt,
          dischargeDisposition: 'home',
          dischargeCondition: 'improved',
        })
        .expect(200);
      const discharged = response.body as Encounter;

      expect(discharged).toMatchObject({
        id: stay.id,
        status: 'finished',
        lastAdtEvent: 'A03',
      });
      expect(discharged.periodEnd).not.toBeNull();
      expect(discharged.lengthOfStayDays).toBeGreaterThanOrEqual(1);
      expect(await occupant(bedB)).toBeNull();

      const overview = await live.admin
        .get(`/api/v1/emr/patients/${patient.id}/overview`)
        .expect(200);
      expect(
        (overview.body as { activeEncounter: unknown }).activeEncounter,
      ).toBeNull();
    });

    it('rejects actions on a closed encounter', async () => {
      const again = await live.admin
        .post('/api/v1/adt/discharge')
        .send({
          encounterId: stay.id,
          dischargeDateTime: new Date().toISOString(),
          dischargeDisposition: 'home',
          dischargeCondition: 'stable',
        })
        .expect(400);
      expect((again.body as { message: string }).message).toMatch(/closed/i);

      await live.admin
        .post('/api/v1/adt/transfer')
        .send({
          encounterId: stay.id,
          bedLocationId: bedA,
          transferReason: 'late',
        })
        .expect(400);
    });

    it('queues the discharge SMS', async () => {
      const row = await eventually(async () => {
        const log = await live.admin
          .get('/api/v1/emr/notifications')
          .query({ eventCode: 'NOTIF_ADT_DISCHARGE', limit: 100 })
          .expect(200);
        return (
          log.body as { items: { patientId: string; status: string }[] }
        ).items.find((item) => item.patientId === patient.id);
      });
      expect(['SENT', 'PENDING']).toContain(row.status);
    });

    it('lists the finished stay under the patient encounters', async () => {
      const response = await live.admin
        .get(`/api/v1/emr/patients/${patient.id}/encounters`)
        .expect(200);
      const items = (
        response.body as { items: { id: string; status: string }[] }
      ).items;
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: stay.id, status: 'finished' }),
          expect.objectContaining({ id: preadmit.id, status: 'cancelled' }),
        ]),
      );
      expect(items).toHaveLength(2);
    });
  });

  describe('direct admission', () => {
    it('A01: admits straight into a bed, then discharges', async () => {
      const patient = await registerPatient(live);
      const [bed] = await freeBeds(live);

      const admitted = (
        await live.admin
          .post('/api/v1/adt/admit')
          .send({
            patientId: patient.id,
            admitType: 'emergency',
            admitSource: 'emd',
            bedLocationId: bed,
          })
          .expect(201)
      ).body as Encounter;
      expect(admitted.visitNumber).toMatch(/^IP-\d{4}-\d+$/);
      expect(await occupant(bed)).toBe(admitted.id);

      await live.admin
        .post('/api/v1/adt/discharge')
        .send({
          encounterId: admitted.id,
          dischargeDateTime: new Date().toISOString(),
          dischargeDisposition: 'home',
          dischargeCondition: 'stable',
        })
        .expect(200);
      expect(await occupant(bed)).toBeNull();
    });

    it('validates the admit payload', async () => {
      const patient = await registerPatient(live);
      const [bed] = await freeBeds(live);

      await live.admin
        .post('/api/v1/adt/admit')
        .send({
          patientId: patient.id,
          admitType: 'whenever',
          bedLocationId: bed,
        })
        .expect(400);
      await live.admin
        .post('/api/v1/adt/admit')
        .send({ patientId: patient.id, admitType: 'routine' })
        .expect(400);
      await live.admin
        .post('/api/v1/adt/admit')
        .send({
          patientId: '00000000-0000-4000-8000-000000000000',
          admitType: 'routine',
          bedLocationId: bed,
        })
        .expect(404);
      expect(await occupant(bed)).toBeNull();
    });
  });

  describe('A04: outpatient and emergency visits', () => {
    it('registers an OPD visit and shows it under the OPD filter', async () => {
      const patient = await registerPatient(live);

      const visit = (
        await live.admin
          .post('/api/v1/adt/register')
          .send({
            patientId: patient.id,
            patientClass: 'AMB',
            visitReason: `${live.runTag} follow up`,
          })
          .expect(201)
      ).body as Encounter;
      expect(visit).toMatchObject({
        status: 'in-progress',
        patientClass: 'AMB',
        lastAdtEvent: 'A04',
      });
      expect(visit.visitNumber).toMatch(/^OP-\d{4}-\d+$/);

      const opd = await live.admin
        .get('/api/v1/emr/patients')
        .query({ filter: 'opd', q: patient.mrn })
        .expect(200);
      expect((opd.body as { items: { id: string }[] }).items).toHaveLength(1);
    });

    it('registers an ED visit with triage and shows it under the ED filter', async () => {
      const patient = await registerPatient(live);

      const visit = (
        await live.admin
          .post('/api/v1/adt/register')
          .send({
            patientId: patient.id,
            patientClass: 'EMER',
            triageCategory: 'urgent',
            arrivalMode: 'ambulance',
          })
          .expect(201)
      ).body as Encounter;
      expect(visit.patientClass).toBe('EMER');

      const ed = await live.admin
        .get('/api/v1/emr/patients')
        .query({ filter: 'ed', q: patient.mrn })
        .expect(200);
      expect((ed.body as { items: { id: string }[] }).items).toHaveLength(1);
    });

    it('does not allow an inpatient class on the register endpoint', async () => {
      const patient = await registerPatient(live);
      await live.admin
        .post('/api/v1/adt/register')
        .send({ patientId: patient.id, patientClass: 'IMP' })
        .expect(400);
    });

    it('cannot discharge or transfer a non-inpatient encounter', async () => {
      const patient = await registerPatient(live);
      const [bed] = await freeBeds(live);
      const visit = (
        await live.admin
          .post('/api/v1/adt/register')
          .send({ patientId: patient.id, patientClass: 'AMB' })
          .expect(201)
      ).body as Encounter;

      await live.admin
        .post('/api/v1/adt/discharge')
        .send({
          encounterId: visit.id,
          dischargeDateTime: new Date().toISOString(),
          dischargeDisposition: 'home',
          dischargeCondition: 'stable',
        })
        .expect(400);
      await live.admin
        .post('/api/v1/adt/transfer')
        .send({
          encounterId: visit.id,
          bedLocationId: bed,
          transferReason: 'x',
        })
        .expect(400);
    });
  });

  describe('bed board', () => {
    it('returns the location tree with wards, rooms and beds', async () => {
      const board = (await live.admin.get('/api/v1/adt/beds').expect(200))
        .body as Board;
      const types = new Set(
        board.locations.map((location) => location.physicalType),
      );
      for (const type of ['wa', 'ro', 'bd']) expect(types.has(type)).toBe(true);
    });
  });

  describe('access', () => {
    it('requires a session and the PATIENT_MGMT permissions', async () => {
      await live.anonymous().get('/api/v1/adt/beds').expect(401);
      await live.anonymous().post('/api/v1/adt/admit').send({}).expect(401);

      const limited = await live.limitedUser();
      await limited.get('/api/v1/adt/beds').expect(403);
      await limited
        .post('/api/v1/adt/admit')
        .send({
          patientId: '00000000-0000-4000-8000-000000000000',
          admitType: 'routine',
          bedLocationId: '00000000-0000-4000-8000-000000000001',
        })
        .expect(403);
      await limited.post('/api/v1/adt/discharge').send({}).expect(403);
    });
  });
});
