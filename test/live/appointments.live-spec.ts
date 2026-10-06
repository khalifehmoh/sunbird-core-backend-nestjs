import {
  Live,
  describeLive,
  eventually,
  hl7LocalOf,
  hl7Message,
  nextFreeSlot,
  pid,
  registerPatient,
  startLive,
} from './helpers';

type Appointment = {
  id: string;
  status: string;
  start: string | null;
  durationMinutes: number | null;
  type: string | null;
  reason: string | null;
  patientId: string | null;
  patientName: string | null;
  mrn: string | null;
  practitionerId: string | null;
  cancellationReason: string | null;
};

type SlotDay = {
  date: string;
  working: boolean;
  slots: { start: string; status: string }[];
};

const ackCode = (ack: string) => /MSA\|(A[AER])\|/.exec(ack)?.[1];

describeLive('Appointments (live Medplum)', () => {
  let live: Live;
  let practitionerId: string;

  const appointments = async (query: Record<string, string>) =>
    (
      (
        await live.admin
          .get('/api/v1/emr/appointments')
          .query(query)
          .expect(200)
      ).body as { items: Appointment[] }
    ).items;

  beforeAll(async () => {
    live = await startLive();
    const providers = (
      await live.admin.get('/api/v1/emr/appointments/providers').expect(200)
    ).body as { items: { id: string; name: string }[] };
    if (!providers.items[0])
      throw new Error('No practitioners are provisioned');
    practitionerId = providers.items[0].id;
  });

  afterAll(async () => {
    await live?.app.close();
  });

  it('returns the clinic hours and a week of slots', async () => {
    const clinic = (
      await live.admin.get('/api/v1/emr/appointments/clinic').expect(200)
    ).body as {
      slotMinutes: number;
      dayStartHour: number;
      dayEndHour: number;
      workingDays: number[];
    };
    expect(clinic).toMatchObject({
      slotMinutes: 30,
      dayStartHour: 8,
      dayEndHour: 16,
    });
    expect(clinic.workingDays).toEqual([0, 1, 2, 3, 4]);

    const today = new Date().toISOString().slice(0, 10);
    const slots = (
      await live.admin
        .get('/api/v1/emr/appointments/slots')
        .query({ practitionerId, from: today, days: 7 })
        .expect(200)
    ).body as { days: SlotDay[] };
    expect(slots.days).toHaveLength(7);
    for (const day of slots.days) {
      expect(day.slots.length).toBeGreaterThan(0);
      if (!day.working) {
        expect(day.slots.every((slot) => slot.status === 'blocked')).toBe(true);
      }
    }
  });

  it('books, reads, lists, then cancels an appointment', async () => {
    const patient = await registerPatient(live);
    const slot = await nextFreeSlot(live, practitionerId);

    const booked = (
      await live.admin
        .post('/api/v1/emr/appointments')
        .send({
          patientId: patient.id,
          practitionerId,
          start: slot.start,
          type: 'FOLLOWUP',
          reason: `${live.runTag} follow up`,
        })
        .expect(201)
    ).body as Appointment;
    expect(booked).toMatchObject({
      status: 'booked',
      type: 'FOLLOWUP',
      durationMinutes: 30,
      patientId: patient.id,
      mrn: patient.mrn,
      practitionerId,
      reason: `${live.runTag} follow up`,
    });
    expect(booked.start).toBe(slot.start);

    const read = await live.admin
      .get(`/api/v1/emr/appointments/${booked.id}`)
      .expect(200);
    expect(read.body).toMatchObject({ id: booked.id, status: 'booked' });

    expect(
      (await appointments({ patientId: patient.id })).map((row) => row.id),
    ).toEqual([booked.id]);
    expect(
      await appointments({ patientId: patient.id, status: 'booked' }),
    ).toHaveLength(1);
    expect(
      await appointments({
        patientId: patient.id,
        practitionerId,
      }),
    ).toHaveLength(1);

    const today = new Date().toISOString().slice(0, 10);
    const afterBook = (
      await live.admin
        .get('/api/v1/emr/appointments/slots')
        .query({ practitionerId, from: today, days: 14 })
        .expect(200)
    ).body as { days: SlotDay[] };
    const bookedSlot = afterBook.days
      .flatMap((day) => day.slots)
      .find((s) => s.start === slot.start);
    expect(bookedSlot?.status).toBe('booked');

    const cancelled = (
      await live.admin
        .post(`/api/v1/emr/appointments/${booked.id}/cancel`)
        .send({ reason: `${live.runTag} patient request` })
        .expect(200)
    ).body as Appointment;
    expect(cancelled).toMatchObject({
      id: booked.id,
      status: 'cancelled',
      cancellationReason: `${live.runTag} patient request`,
      patientName: patient.name,
    });

    const afterCancel = (
      await live.admin
        .get('/api/v1/emr/appointments/slots')
        .query({ practitionerId, from: today, days: 14 })
        .expect(200)
    ).body as { days: SlotDay[] };
    expect(
      afterCancel.days
        .flatMap((day) => day.slots)
        .find((s) => s.start === slot.start)?.status,
    ).toBe('free');
  });

  it('refuses a double-booked slot and a cancelled appointment being cancelled again', async () => {
    const first = await registerPatient(live);
    const second = await registerPatient(live);
    const slot = await nextFreeSlot(live, practitionerId);

    const booked = (
      await live.admin
        .post('/api/v1/emr/appointments')
        .send({
          patientId: first.id,
          practitionerId,
          start: slot.start,
        })
        .expect(201)
    ).body as Appointment;

    const clash = await live.admin
      .post('/api/v1/emr/appointments')
      .send({
        patientId: second.id,
        practitionerId,
        start: slot.start,
      })
      .expect(409);
    expect((clash.body as { message: string }).message).toMatch(
      /no longer available|already/i,
    );

    await live.admin
      .post(`/api/v1/emr/appointments/${booked.id}/cancel`)
      .send({ reason: 'cleanup' })
      .expect(200);
    await live.admin
      .post(`/api/v1/emr/appointments/${booked.id}/cancel`)
      .send({ reason: 'again' })
      .expect(400);
  });

  it('rejects a Saturday, a past slot and a missing reason on cancel', async () => {
    const patient = await registerPatient(live);

    // 2026-10-10 is a Saturday (clinic closed; working days are Sun–Thu).
    await live.admin
      .post('/api/v1/emr/appointments')
      .send({
        patientId: patient.id,
        practitionerId,
        start: '2026-10-10T06:00:00.000Z',
      })
      .expect(400);

    await live.admin
      .post('/api/v1/emr/appointments')
      .send({
        patientId: patient.id,
        practitionerId,
        start: '2020-01-05T06:00:00.000Z',
      })
      .expect(400);

    const slot = await nextFreeSlot(live, practitionerId);
    const booked = (
      await live.admin
        .post('/api/v1/emr/appointments')
        .send({
          patientId: patient.id,
          practitionerId,
          start: slot.start,
        })
        .expect(201)
    ).body as Appointment;
    await live.admin
      .post(`/api/v1/emr/appointments/${booked.id}/cancel`)
      .send({})
      .expect(400);
    await live.admin
      .post(`/api/v1/emr/appointments/${booked.id}/no-show`)
      .expect(400);
    await live.admin
      .post(`/api/v1/emr/appointments/${booked.id}/cancel`)
      .send({ reason: 'cleanup' })
      .expect(200);
  });

  it('queues booked and cancelled SMS', async () => {
    const patient = await registerPatient(live);
    const slot = await nextFreeSlot(live, practitionerId);
    const booked = (
      await live.admin
        .post('/api/v1/emr/appointments')
        .send({
          patientId: patient.id,
          practitionerId,
          start: slot.start,
          reason: `${live.runTag} sms`,
        })
        .expect(201)
    ).body as Appointment;

    const bookedSms = await eventually(async () => {
      const log = await live.admin
        .get('/api/v1/emr/notifications')
        .query({ eventCode: 'NOTIF_SCH_BOOKED', limit: 100 })
        .expect(200);
      return (
        log.body as { items: { patientId: string; status: string }[] }
      ).items.find((item) => item.patientId === patient.id);
    });
    expect(['SENT', 'PENDING']).toContain(bookedSms.status);

    await live.admin
      .post(`/api/v1/emr/appointments/${booked.id}/cancel`)
      .send({ reason: 'sms test' })
      .expect(200);

    const cancelledSms = await eventually(async () => {
      const log = await live.admin
        .get('/api/v1/emr/notifications')
        .query({ eventCode: 'NOTIF_SCH_CANCELLED', limit: 100 })
        .expect(200);
      return (
        log.body as { items: { patientId: string; status: string }[] }
      ).items.find((item) => item.patientId === patient.id);
    });
    expect(['SENT', 'PENDING']).toContain(cancelledSms.status);
  });

  it('books and cancels through SIU S12 / S15, and treats a redelivery as a no-op', async () => {
    const patient = await registerPatient(live);
    const slot = await nextFreeSlot(live, practitionerId);
    const externalId = `${live.runTag}-APPT`;
    const stamp = hl7LocalOf(slot.start);

    const booked = await live.hl7(
      hl7Message('SIU^S12', `${live.runTag}-S12`, [
        `SCH|${externalId}||||||ROUTINE^Routine check||30|min|^^^${stamp}`,
        pid(patient.mrn),
        `AIP|1||${practitionerId}^Provider`,
      ]),
    );
    expect(ackCode(booked.ack)).toBe('AA');
    expect(booked.ack).toMatch(/booked/i);

    const listed = await appointments({ patientId: patient.id });
    const row = listed.find((item) => item.start === slot.start);
    expect(row).toMatchObject({
      status: 'booked',
      practitionerId,
      mrn: patient.mrn,
      start: slot.start,
    });

    const redelivered = await live.hl7(
      hl7Message('SIU^S12', `${live.runTag}-S12`, [
        `SCH|${externalId}||||||ROUTINE^Routine check||30|min|^^^${stamp}`,
        pid(patient.mrn),
        `AIP|1||${practitionerId}^Provider`,
      ]),
    );
    expect(ackCode(redelivered.ack)).toBe('AA');
    expect(
      (await appointments({ patientId: patient.id })).filter(
        (item) => item.start === slot.start,
      ),
    ).toHaveLength(1);

    const cancelled = await live.hl7(
      hl7Message('SIU^S15', `${live.runTag}-S15`, [
        `SCH|${externalId}|||||Patient request^Patient request`,
        pid(patient.mrn),
      ]),
    );
    expect(ackCode(cancelled.ack)).toBe('AA');
    expect(
      (await appointments({ patientId: patient.id })).find(
        (item) => item.id === row?.id,
      )?.status,
    ).toBe('cancelled');
  });

  it('answers AE for an SIU with an unknown provider', async () => {
    const patient = await registerPatient(live);
    const slot = await nextFreeSlot(live, practitionerId);
    const response = await live.hl7(
      hl7Message('SIU^S12', `${live.runTag}-S12BAD`, [
        `SCH|${live.runTag}-MISSING||||||ROUTINE^Routine||30|min|^^^${hl7LocalOf(slot.start)}`,
        pid(patient.mrn),
        'AIP|1||00000000-0000-4000-8000-000000000000^Nobody',
      ]),
    );
    expect(ackCode(response.ack)).toBe('AE');
  });

  it('requires a session and the APPOINTMENT_MGMT permissions', async () => {
    await live.anonymous().get('/api/v1/emr/appointments').expect(401);
    const limited = await live.limitedUser();
    await limited.get('/api/v1/emr/appointments').expect(403);
    await limited.post('/api/v1/emr/appointments').send({}).expect(403);
  });
});
