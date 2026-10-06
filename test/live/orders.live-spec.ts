import {
  Live,
  describeLive,
  eventually,
  hl7Message,
  hl7Timestamp,
  pid,
  registerPatient,
  startLive,
} from './helpers';

type Order = {
  id: string;
  orderNumber: string | null;
  type: string | null;
  code: string | null;
  display: string | null;
  priority: string;
  status: string;
  patientId: string | null;
  patientName: string | null;
  mrn: string | null;
  notes: string | null;
};

type ResultRow = {
  id: string;
  controlId: string | null;
  orderNumber: string | null;
  hasCritical: boolean;
  patientId: string | null;
  mrn: string | null;
};

const ackCode = (ack: string) => /MSA\|(A[AER])\|/.exec(ack)?.[1];

describeLive('Orders (live Medplum)', () => {
  let live: Live;

  const orders = async (query: Record<string, string>) =>
    (
      (await live.admin.get('/api/v1/emr/orders').query(query).expect(200))
        .body as { items: Order[] }
    ).items;

  beforeAll(async () => {
    live = await startLive();
  });

  afterAll(async () => {
    await live?.app.close();
  });

  describe('manual orders', () => {
    it('lists the catalog and filters it by type and text', async () => {
      const all = (
        await live.admin.get('/api/v1/emr/orders/catalog').expect(200)
      ).body as { items: { code: string; display: string; type: string }[] };
      expect(all.items.length).toBeGreaterThan(0);
      expect(all.items.map((entry) => entry.type)).toEqual(
        expect.arrayContaining(['LAB']),
      );

      const hemoglobin = (
        await live.admin
          .get('/api/v1/emr/orders/catalog')
          .query({ type: 'LAB', q: 'hemoglobin' })
          .expect(200)
      ).body as { items: { code: string; type: string }[] };
      expect(hemoglobin.items.map((entry) => entry.code)).toContain('718-7');
      expect(hemoglobin.items.every((entry) => entry.type === 'LAB')).toBe(
        true,
      );
    });

    it('creates, reads, lists and cancels an order', async () => {
      const patient = await registerPatient(live);

      const created = (
        await live.admin
          .post('/api/v1/emr/orders')
          .send({
            patientId: patient.id,
            type: 'LAB',
            code: '718-7',
            priority: 'URGENT',
            notes: `${live.runTag} manual order`,
          })
          .expect(201)
      ).body as Order;
      expect(created).toMatchObject({
        type: 'LAB',
        code: '718-7',
        priority: 'URGENT',
        status: 'active',
        patientId: patient.id,
        mrn: patient.mrn,
        notes: `${live.runTag} manual order`,
      });
      expect(created.orderNumber).toMatch(/^ORD-\d{4}-\d+$/);
      expect(created.display).toBeTruthy();

      const read = await live.admin
        .get(`/api/v1/emr/orders/${created.id}`)
        .expect(200);
      expect(read.body).toMatchObject({
        id: created.id,
        orderNumber: created.orderNumber,
        patientName: patient.name,
      });

      expect(
        (await orders({ patientId: patient.id })).map((o) => o.id),
      ).toEqual([created.id]);
      expect(
        await orders({
          patientId: patient.id,
          status: 'active',
          priority: 'URGENT',
        }),
      ).toHaveLength(1);
      expect(
        await orders({ patientId: patient.id, priority: 'STAT' }),
      ).toHaveLength(0);
      expect(await orders({ patientId: patient.id, type: 'RAD' })).toHaveLength(
        0,
      );

      const cancelled = (
        await live.admin
          .post(`/api/v1/emr/orders/${created.id}/cancel`)
          .send({ reason: `${live.runTag} entered twice` })
          .expect(200)
      ).body as Order;
      expect(cancelled).toMatchObject({
        id: created.id,
        status: 'revoked',
        // Regression: the cancel response used to lose the patient.
        patientName: patient.name,
        mrn: patient.mrn,
      });
      expect(
        await orders({ patientId: patient.id, status: 'revoked' }),
      ).toHaveLength(1);

      const again = await live.admin
        .post(`/api/v1/emr/orders/${created.id}/cancel`)
        .send({ reason: 'twice' })
        .expect(400);
      expect((again.body as { message: string }).message).toMatch(
        /cannot be cancelled/i,
      );
    });

    it('accepts a LOINC code outside the catalog when a display is given', async () => {
      const patient = await registerPatient(live);

      await live.admin
        .post('/api/v1/emr/orders')
        .send({ patientId: patient.id, type: 'LAB', code: '99999-9' })
        .expect(400);

      const created = await live.admin
        .post('/api/v1/emr/orders')
        .send({
          patientId: patient.id,
          type: 'RAD',
          code: '99999-9',
          display: `${live.runTag} custom study`,
        })
        .expect(201);
      expect(created.body).toMatchObject({
        type: 'RAD',
        priority: 'ROUTINE',
        display: `${live.runTag} custom study`,
      });
    });

    it('rejects bad input and unknown patients', async () => {
      const patient = await registerPatient(live);

      const badCode = await live.admin
        .post('/api/v1/emr/orders')
        .send({ patientId: patient.id, type: 'LAB', code: 'hemoglobin' })
        .expect(400);
      expect(
        (badCode.body as { errors: Record<string, string> }).errors,
      ).toHaveProperty('code');
      await live.admin
        .post('/api/v1/emr/orders')
        .send({ patientId: patient.id, type: 'PHARMACY', code: '718-7' })
        .expect(400);
      await live.admin
        .post('/api/v1/emr/orders')
        .send({
          patientId: '00000000-0000-4000-8000-000000000000',
          type: 'LAB',
          code: '718-7',
        })
        .expect(404);
      await live.admin
        .post('/api/v1/emr/orders/00000000-0000-4000-8000-000000000000/cancel')
        .send({ reason: 'x' })
        .expect(404);
      await live.admin
        .post('/api/v1/emr/orders/00000000-0000-4000-8000-000000000000/cancel')
        .send({})
        .expect(400);
    });

    it('requires a session and the PATIENT_MGMT permissions', async () => {
      await live.anonymous().get('/api/v1/emr/orders').expect(401);
      const limited = await live.limitedUser();
      await limited.get('/api/v1/emr/orders').expect(403);
      await limited
        .post('/api/v1/emr/orders')
        .send({
          patientId: '00000000-0000-4000-8000-000000000000',
          type: 'LAB',
          code: '718-7',
        })
        .expect(403);
    });
  });

  describe('orders and results from an external system (HL7 v2)', () => {
    it('creates an order from ORM NW, then cancels it with ORM CA', async () => {
      const patient = await registerPatient(live);
      const placer = `${live.runTag}-ORM`;
      const stamp = hl7Timestamp();

      const created = await live.hl7(
        hl7Message('ORM^O01', `${live.runTag}-M1`, [
          pid(patient.mrn),
          `ORC|NW|${placer}`,
          `OBR|1|${placer}||718-7^Hemoglobin^LN||||${stamp}`,
        ]),
      );
      expect(created.status).toBe(200);
      expect(ackCode(created.ack)).toBe('AA');
      expect(created.messageId).toBeTruthy();

      const order = (await orders({ patientId: patient.id })).find(
        (o) => o.orderNumber === placer,
      );
      expect(order).toMatchObject({
        status: 'active',
        code: '718-7',
        mrn: patient.mrn,
      });

      // Redelivery of the same message is acknowledged, not duplicated.
      const redelivered = await live.hl7(
        hl7Message('ORM^O01', `${live.runTag}-M1`, [
          pid(patient.mrn),
          `ORC|NW|${placer}`,
          `OBR|1|${placer}||718-7^Hemoglobin^LN||||${stamp}`,
        ]),
      );
      expect(ackCode(redelivered.ack)).toBe('AA');
      expect(
        (await orders({ patientId: patient.id })).filter(
          (o) => o.orderNumber === placer,
        ),
      ).toHaveLength(1);

      const cancelled = await live.hl7(
        hl7Message('ORM^O01', `${live.runTag}-M2`, [
          pid(patient.mrn),
          [
            'ORC',
            'CA',
            placer,
            ...(Array(13).fill('') as string[]),
            'OE^Ordered in error',
          ].join('|'),
          `OBR|1|${placer}||718-7^Hemoglobin^LN`,
        ]),
      );
      expect(ackCode(cancelled.ack)).toBe('AA');
      expect(
        (await orders({ patientId: patient.id })).find(
          (o) => o.orderNumber === placer,
        )?.status,
      ).toBe('revoked');
    });

    it('stores a critical ORU against the order and surfaces it everywhere', async () => {
      const patient = await registerPatient(live);
      const placer = `${live.runTag}-ORU`;
      const stamp = hl7Timestamp();

      await live.hl7(
        hl7Message('ORM^O01', `${live.runTag}-O1`, [
          pid(patient.mrn),
          `ORC|NW|${placer}`,
          `OBR|1|${placer}||718-7^Hemoglobin^LN||||${stamp}`,
        ]),
      );

      const reported = await live.hl7(
        hl7Message('ORU^R01', `${live.runTag}-R1`, [
          pid(patient.mrn),
          `OBR|1|${placer}||718-7^Hemoglobin^LN|||${stamp}`,
          'OBX|1|NM|718-7^Hemoglobin^LN||6.1|g/dL|13.5-17.5|LL|||F',
        ]),
      );
      expect(ackCode(reported.ack)).toBe('AA');

      // Result list, filtered to the patient, flags the critical report.
      const list = (
        await live.admin
          .get('/api/v1/emr/results')
          .query({ patientId: patient.id })
          .expect(200)
      ).body as { items: ResultRow[]; criticalCount: number };
      expect(list.items).toEqual([
        expect.objectContaining({
          orderNumber: placer,
          hasCritical: true,
          mrn: patient.mrn,
        }),
      ]);
      expect(list.criticalCount).toBeGreaterThanOrEqual(1);

      // Viewer shows the observation as critical.
      const detail = (
        await live.admin
          .get(`/api/v1/emr/results/${list.items[0].id}`)
          .expect(200)
      ).body as {
        observations: { flag: string; numericValue: number; unit: string }[];
      };
      expect(detail.observations).toEqual([
        expect.objectContaining({
          flag: 'critical',
          numericValue: 6.1,
          unit: 'g/dL',
        }),
      ]);

      // Critical alerts page. Regression: this scanned an unsupported search parameter.
      const alerts = (
        await live.admin
          .get('/api/v1/emr/results/critical')
          .query({ patientId: patient.id })
          .expect(200)
      ).body as { items: { patientId: string; flag: string }[] };
      expect(alerts.items).toEqual([
        expect.objectContaining({ patientId: patient.id, flag: 'critical' }),
      ]);

      // Working list: the patient is under the Critical chip.
      const worklist = (
        await live.admin
          .get('/api/v1/emr/patients')
          .query({ filter: 'critical', q: patient.mrn })
          .expect(200)
      ).body as { items: { id: string; critical: boolean }[] };
      expect(worklist.items).toEqual([
        expect.objectContaining({ id: patient.id, critical: true }),
      ]);

      // The critical-only filter on the result list.
      const criticalOnly = (
        await live.admin
          .get('/api/v1/emr/results')
          .query({ patientId: patient.id, criticalOnly: 'true' })
          .expect(200)
      ).body as { items: ResultRow[] };
      expect(criticalOnly.items).toHaveLength(1);
    });

    it('does not duplicate a result when the same ORU is redelivered', async () => {
      const patient = await registerPatient(live);
      const message = hl7Message('ORU^R01', `${live.runTag}-R2`, [
        pid(patient.mrn),
        `OBR|1|||2951-2^Sodium^LN|||${hl7Timestamp()}`,
        'OBX|1|NM|2951-2^Sodium^LN||140|mmol/L|135-145|N|||F',
      ]);

      expect(ackCode((await live.hl7(message)).ack)).toBe('AA');
      expect(ackCode((await live.hl7(message)).ack)).toBe('AA');

      const list = (
        await live.admin
          .get('/api/v1/emr/results')
          .query({ patientId: patient.id })
          .expect(200)
      ).body as { items: ResultRow[] };
      expect(list.items).toHaveLength(1);
      expect(list.items[0].hasCritical).toBe(false);
    });

    it('answers AE for an unknown patient and records the failed message', async () => {
      const bad = await live.hl7(
        hl7Message('ORU^R01', `${live.runTag}-BAD`, [
          pid('NO-SUCH-MRN'),
          `OBR|1|||718-7^Hemoglobin^LN|||${hl7Timestamp()}`,
          'OBX|1|NM|718-7^Hemoglobin^LN||13|g/dL|13.5-17.5|N|||F',
        ]),
      );
      expect(ackCode(bad.ack)).toBe('AE');
      expect(bad.ack).toContain('PATIENT_NOT_FOUND');

      const failed = await eventually(async () => {
        const messages = (
          await live.admin
            .get('/api/v1/emr/integration/messages')
            .query({ status: 'FAILED' })
            .expect(200)
        ).body as {
          items: { id: string; controlId: string; status: string }[];
        };
        return messages.items.find(
          (message) => message.controlId === `${live.runTag}-BAD`,
        );
      });
      expect(failed.status).toBe('FAILED');

      const detail = await live.admin
        .get(`/api/v1/emr/integration/messages/${failed.id}`)
        .expect(200);
      expect(JSON.stringify(detail.body)).toContain('PATIENT_NOT_FOUND');
    });

    it('answers AR for text that is not HL7', async () => {
      const response = await live.hl7('this is not hl7');
      expect(ackCode(response.ack)).toBe('AR');
    });

    it('guards the inbound endpoint with the integration key and a known tenant', async () => {
      const message = hl7Message('ORU^R01', `${live.runTag}-AUTH`, [
        pid('X-1'),
        'OBR|1|||718-7^Hemoglobin^LN',
      ]);

      expect(
        (await live.hl7(message, { key: 'wrong-key-wrong-key-wrong-key' }))
          .status,
      ).toBe(401);
      expect(
        (
          await live.hl7(message, {
            tenantId: '00000000-0000-4000-8000-000000000000',
          })
        ).status,
      ).toBe(400);
    });
  });
});
