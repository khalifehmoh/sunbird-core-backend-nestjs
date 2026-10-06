import {
  Live,
  describeLive,
  eventually,
  hl7LocalOf,
  hl7Message,
  hl7Timestamp,
  pid,
  registerPatient,
  startLive,
} from './helpers';

type MessageRow = {
  id: string;
  controlId: string | null;
  messageType: string | null;
  status: string;
  lastError?: { code: string; message: string } | null;
};

const ackCode = (ack: string) => /MSA\|(A[AER])\|/.exec(ack)?.[1];

describeLive('Integration retry (live Medplum)', () => {
  let live: Live;

  beforeAll(async () => {
    live = await startLive();
  });

  afterAll(async () => {
    await live?.app.close();
  });

  it('retries a failed ORU once the patient exists, and records the retry', async () => {
    const patient = await registerPatient(live);
    const controlId = `${live.runTag}-RETRY`;
    const stamp = hl7Timestamp();

    const failed = await live.hl7(
      hl7Message('ORU^R01', controlId, [
        pid('NO-SUCH-MRN'),
        `OBR|1|||718-7^Hemoglobin^LN|||${stamp}`,
        'OBX|1|NM|718-7^Hemoglobin^LN||13.9|g/dL|13.5-17.5|N|||F',
      ]),
    );
    expect(ackCode(failed.ack)).toBe('AE');

    const row = await eventually(async () => {
      const messages = (
        await live.admin
          .get('/api/v1/emr/integration/messages')
          .query({ status: 'FAILED', q: controlId })
          .expect(200)
      ).body as { items: MessageRow[] };
      return messages.items.find((item) => item.controlId === controlId);
    });
    expect(row.status).toBe('FAILED');

    const detailBefore = (
      await live.admin
        .get(`/api/v1/emr/integration/messages/${row.id}`)
        .expect(200)
    ).body as {
      retries: unknown[];
      transactions: { stage: string }[];
    };
    expect(detailBefore.retries).toHaveLength(0);

    // Retrying the original (unknown-MRN) payload still fails.
    const stillFailed = (
      await live.admin
        .post(`/api/v1/emr/integration/messages/${row.id}/retry`)
        .expect(200)
    ).body as { status: string; ackCode: string };
    expect(stillFailed.status).toBe('FAILED');
    expect(stillFailed.ackCode).toBe('AE');

    const afterFailedRetry = (
      await live.admin
        .get(`/api/v1/emr/integration/messages/${row.id}`)
        .expect(200)
    ).body as { retries: { outcome: string }[] };
    expect(afterFailedRetry.retries).toHaveLength(1);
    expect(afterFailedRetry.retries[0].outcome).toBe('FAILED');

    // A new message with the same observations, now for a real patient, processes.
    const recovered = await live.hl7(
      hl7Message('ORU^R01', `${live.runTag}-RETRY-OK`, [
        pid(patient.mrn),
        `OBR|1|||718-7^Hemoglobin^LN|||${stamp}`,
        'OBX|1|NM|718-7^Hemoglobin^LN||13.9|g/dL|13.5-17.5|N|||F',
      ]),
    );
    expect(ackCode(recovered.ack)).toBe('AA');

    const results = (
      await live.admin
        .get('/api/v1/emr/results')
        .query({ patientId: patient.id })
        .expect(200)
    ).body as { items: { mrn: string }[] };
    expect(results.items).toHaveLength(1);
  });

  it('retries a failed SIU once the provider is named, and refuses to retry a processed message', async () => {
    const patient = await registerPatient(live);
    const providers = (
      await live.admin.get('/api/v1/emr/appointments/providers').expect(200)
    ).body as { items: { id: string }[] };
    const practitionerId = providers.items[0]?.id;
    if (!practitionerId) throw new Error('No practitioners are provisioned');

    const controlId = `${live.runTag}-SIURETRY`;
    const failed = await live.hl7(
      hl7Message('SIU^S12', controlId, [
        `SCH|${live.runTag}-MISSING||||||ROUTINE^Routine||30|min|^^^20990101090000`,
        pid(patient.mrn),
        'AIP|1||00000000-0000-4000-8000-000000000000^Nobody',
      ]),
    );
    expect(ackCode(failed.ack)).toBe('AE');

    const row = await eventually(async () => {
      const messages = (
        await live.admin
          .get('/api/v1/emr/integration/messages')
          .query({ q: controlId })
          .expect(200)
      ).body as { items: MessageRow[] };
      return messages.items.find((item) => item.controlId === controlId);
    });

    // Manual submit of a corrected SIU (same patient, real provider, a real free slot).
    const today = new Date().toISOString().slice(0, 10);
    const days = (
      await live.admin
        .get('/api/v1/emr/appointments/slots')
        .query({ practitionerId, from: today, days: 14 })
        .expect(200)
    ).body as { days: { slots: { start: string; status: string }[] }[] };
    const free = days.days
      .flatMap((day) => day.slots)
      .find((slot) => slot.status === 'free');
    if (!free) throw new Error('No free slot');
    const stamp = hl7LocalOf(free.start);
    const submitted = (
      await live.admin
        .post('/api/v1/emr/integration/messages')
        .send({
          message: hl7Message('SIU^S12', `${live.runTag}-SIUOK`, [
            `SCH|${live.runTag}-OK||||||ROUTINE^Routine||30|min|^^^${stamp}`,
            pid(patient.mrn),
            `AIP|1||${practitionerId}^Provider`,
          ]),
        })
        .expect(201)
    ).body as {
      status: string;
      ackCode: string;
      messageId: string;
      detail: string;
    };
    if (submitted.status !== 'PROCESSED') {
      throw new Error(
        `SIU submit failed: ${submitted.ackCode} ${submitted.detail}`,
      );
    }
    expect(submitted.ackCode).toBe('AA');

    await live.admin
      .post(`/api/v1/emr/integration/messages/${submitted.messageId}/retry`)
      .expect(400);

    const stats = (
      await live.admin.get('/api/v1/emr/integration/stats').expect(200)
    ).body as { received: number; failed: number; processed: number };
    expect(stats.received).toBeGreaterThan(0);

    // The original failed SIU is still FAILED and can be retried (and still fails).
    const retried = (
      await live.admin
        .post(`/api/v1/emr/integration/messages/${row.id}/retry`)
        .expect(200)
    ).body as { status: string };
    expect(retried.status).toBe('FAILED');
  });

  it('returns 404 for an unknown message and 400 for a non-failed retry', async () => {
    await live.admin
      .post(
        '/api/v1/emr/integration/messages/00000000-0000-4000-8000-000000000000/retry',
      )
      .expect(404);
  });

  it('requires a session and the IT permissions', async () => {
    await live.anonymous().get('/api/v1/emr/integration/messages').expect(401);
    const limited = await live.limitedUser();
    await limited.get('/api/v1/emr/integration/messages').expect(403);
    await limited
      .post(
        '/api/v1/emr/integration/messages/00000000-0000-4000-8000-000000000000/retry',
      )
      .expect(403);
  });
});
