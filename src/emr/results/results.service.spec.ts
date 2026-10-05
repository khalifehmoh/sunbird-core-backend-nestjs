import type {
  DiagnosticReport,
  Observation,
  ServiceRequest,
} from '@medplum/fhirtypes';
import { ProcessingError } from '../common/processing-error';
import { EmrEventBus, type EmrEvent } from '../emr-events';
import {
  ORDER_NUMBER_SYSTEM,
  RESULT_FLAG_CRITICAL,
  RESULT_FLAG_SYSTEM,
} from '../emr.constants';
import { ACTOR, buildHarness, encounter } from '../testing/harness';
import type { InboundResult } from './results.dto';
import { normalizeFlag, ResultsService } from './results.service';

const NOW = new Date('2026-10-06T09:00:00.000Z');

function build() {
  const harness = buildHarness();
  harness.store.seed(encounter('enc-1', 'patient-1'));
  harness.store.seed<ServiceRequest>({
    resourceType: 'ServiceRequest',
    id: 'sr-1',
    status: 'active',
    intent: 'order',
    identifier: [{ system: ORDER_NUMBER_SYSTEM, value: 'ORD-2026-00001' }],
    subject: { reference: 'Patient/patient-1' },
    encounter: { reference: 'Encounter/enc-1' },
  });
  const bus = new EmrEventBus();
  const events: EmrEvent[] = [];
  bus.subscribe((event) => {
    events.push(event);
  });
  return {
    ...harness,
    events,
    service: new ResultsService(harness.fhir, bus),
  };
}

const cbc = (overrides: Partial<InboundResult> = {}): InboundResult => ({
  patientId: 'patient-1',
  orderNumber: 'ORD-2026-00001',
  controlId: 'MSG-1',
  code: '58410-2',
  display: 'CBC panel',
  type: 'LAB',
  issuedAt: '2026-10-06T08:30:00.000Z',
  source: 'HL7',
  observations: [
    {
      code: '718-7',
      display: 'Hemoglobin',
      value: '13.2',
      unit: 'g/dL',
      referenceRange: '12.0-16.0',
      flag: 'N',
      status: 'F',
    },
    {
      code: '777-3',
      display: 'Platelets',
      value: '40',
      unit: '10*3/uL',
      referenceRange: '150-400',
      flag: 'LL',
      status: 'F',
    },
  ],
  ...overrides,
});

describe('normalizeFlag', () => {
  it.each([
    ['H', 'H'],
    ['hh', 'HH'],
    ['>', 'H'],
    ['<', 'L'],
    ['AA', 'AA'],
    [undefined, undefined],
    ['Z', undefined],
  ])('%s becomes %s', (input, expected) => {
    expect(normalizeFlag(input)).toBe(expected);
  });
});

describe('ResultsService', () => {
  describe('ingest', () => {
    it('stores a report with its observations and completes the order, atomically', async () => {
      const { store, service, events } = build();

      const outcome = await service.ingest(cbc(), ACTOR.tenantId, NOW);

      expect(outcome).toMatchObject({ duplicate: false, critical: true });
      expect(store.transactions).toHaveLength(1);

      const observations = store.all<Observation>('Observation');
      expect(observations).toHaveLength(2);
      const [report] = store.all<DiagnosticReport>('DiagnosticReport');
      expect(report.result?.map((r) => r.reference).sort()).toEqual(
        observations.map((o) => `Observation/${o.id}`).sort(),
      );
      expect(report).toMatchObject({
        status: 'final',
        subject: { reference: 'Patient/patient-1' },
        encounter: { reference: 'Encounter/enc-1' },
        basedOn: [{ reference: 'ServiceRequest/sr-1' }],
      });
      expect(report.meta?.tag).toContainEqual({
        system: RESULT_FLAG_SYSTEM,
        code: RESULT_FLAG_CRITICAL,
      });
      expect(store.get<ServiceRequest>('ServiceRequest/sr-1').status).toBe(
        'completed',
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        channel: 'emr.oru',
        event: 'R01',
        patientId: 'patient-1',
        data: { critical: true },
      });
    });

    it('stores numeric values as quantities and the rest as text', async () => {
      const { store, service } = build();
      await service.ingest(
        cbc({
          observations: [
            { code: '718-7', display: 'Hb', value: '13.2', unit: 'g/dL' },
            { code: '600-7', display: 'Culture', value: 'No growth' },
          ],
        }),
        ACTOR.tenantId,
        NOW,
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const byCode = Object.fromEntries(
        store
          .all<Observation>('Observation')
          .map((o) => [o.code?.coding?.[0].code, o]),
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(byCode['718-7'].valueQuantity).toMatchObject({
        value: 13.2,
        unit: 'g/dL',
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(byCode['600-7'].valueString).toBe('No growth');
    });

    it('is idempotent on the message control id', async () => {
      const { store, service, events } = build();
      const first = await service.ingest(cbc(), ACTOR.tenantId, NOW);
      const second = await service.ingest(cbc(), ACTOR.tenantId, NOW);

      expect(second).toEqual({
        reportId: first.reportId,
        duplicate: true,
        critical: true,
      });
      expect(store.all('DiagnosticReport')).toHaveLength(1);
      expect(store.all('Observation')).toHaveLength(2);
      expect(events).toHaveLength(1);
    });

    it('runs concurrent redeliveries one at a time', async () => {
      const { store, service } = build();
      const results = await Promise.all([
        service.ingest(cbc(), ACTOR.tenantId, NOW),
        service.ingest(cbc(), ACTOR.tenantId, NOW),
      ]);
      expect(results.filter((r) => r.duplicate)).toHaveLength(1);
      expect(store.all('DiagnosticReport')).toHaveLength(1);
    });

    it('marks a corrected observation and the report as corrected', async () => {
      const { store, service } = build();
      await service.ingest(
        cbc({
          observations: [
            {
              code: '718-7',
              display: 'Hb',
              value: '13.2',
              flag: 'N',
              status: 'C',
            },
          ],
        }),
        ACTOR.tenantId,
        NOW,
      );
      expect(store.all<DiagnosticReport>('DiagnosticReport')[0].status).toBe(
        'corrected',
      );
    });

    it('is not critical when nothing is LL / HH / AA', async () => {
      const { store, service } = build();
      const outcome = await service.ingest(
        cbc({
          observations: [
            {
              code: '718-7',
              display: 'Hb',
              value: '9',
              flag: 'L',
              status: 'F',
            },
          ],
        }),
        ACTOR.tenantId,
        NOW,
      );
      expect(outcome.critical).toBe(false);
      expect(
        store
          .all<DiagnosticReport>('DiagnosticReport')[0]
          .meta?.tag?.some((t) => t.system === RESULT_FLAG_SYSTEM),
      ).toBe(false);
    });

    it.each([
      ['an unknown order', { orderNumber: 'ORD-9' }, 'ORDER_NOT_FOUND'],
      [
        'an unknown patient',
        { patientId: 'nobody', orderNumber: undefined },
        'PATIENT_NOT_FOUND',
      ],
      [
        'another patient’s order',
        { patientId: 'patient-2' },
        'ORDER_PATIENT_MISMATCH',
      ],
      ['no observations', { observations: [] }, 'NO_OBSERVATIONS'],
    ])(
      'rejects %s without writing anything',
      async (_label, override, code) => {
        const { store, service } = build();
        const attempt = service.ingest(cbc(override), ACTOR.tenantId, NOW);
        await expect(attempt).rejects.toBeInstanceOf(ProcessingError);
        await expect(attempt).rejects.toMatchObject({ code });
        expect(store.transactions).toHaveLength(0);
        expect(store.all('Observation')).toHaveLength(0);
      },
    );

    it('rejects a result for a cancelled order', async () => {
      const { store, service } = build();
      store.seed<ServiceRequest>({
        ...store.get<ServiceRequest>('ServiceRequest/sr-1'),
        status: 'revoked',
      });
      await expect(
        service.ingest(cbc(), ACTOR.tenantId, NOW),
      ).rejects.toMatchObject({ code: 'ORDER_CANCELLED' });
    });

    it('stores a result with no order reference', async () => {
      const { store, service } = build();
      await service.ingest(
        cbc({ orderNumber: undefined }),
        ACTOR.tenantId,
        NOW,
      );
      expect(
        store.all<DiagnosticReport>('DiagnosticReport')[0].basedOn,
      ).toBeUndefined();
      expect(store.get<ServiceRequest>('ServiceRequest/sr-1').status).toBe(
        'active',
      );
    });
  });

  describe('reading', () => {
    async function seed() {
      const harness = build();
      await harness.service.ingest(cbc(), ACTOR.tenantId, NOW);
      await harness.service.ingest(
        cbc({
          controlId: 'MSG-2',
          orderNumber: undefined,
          patientId: 'patient-2',
          issuedAt: '2026-10-05T08:00:00.000Z',
          observations: [
            {
              code: '718-7',
              display: 'Hb',
              value: '14',
              flag: 'N',
              status: 'F',
            },
          ],
        }),
        ACTOR.tenantId,
        NOW,
      );
      return harness;
    }

    it('lists reports newest first with patient details and a critical count', async () => {
      const { service } = await seed();
      const { items, criticalCount } = await service.list({}, ACTOR);

      expect(items.map((r) => r.controlId)).toEqual(['MSG-1', 'MSG-2']);
      expect(items[0]).toMatchObject({
        patientName: 'Aisha Rahman',
        mrn: 'T1-00001',
        orderNumber: 'ORD-2026-00001',
        hasCritical: true,
        type: 'LAB',
        source: 'HL7',
      });
      expect(criticalCount).toBe(1);
    });

    it('filters to critical reports and by patient', async () => {
      const { service } = await seed();
      expect(
        (await service.list({ criticalOnly: true }, ACTOR)).items.map(
          (r) => r.controlId,
        ),
      ).toEqual(['MSG-1']);
      expect(
        (await service.list({ patientId: 'patient-2' }, ACTOR)).items.map(
          (r) => r.controlId,
        ),
      ).toEqual(['MSG-2']);
    });

    it('returns one report with its observations flagged', async () => {
      const { service } = await seed();
      const [first] = (await service.list({ patientId: 'patient-1' }, ACTOR))
        .items;
      const detail = await service.get(first.id, ACTOR);

      expect(detail.observations.map((o) => [o.display, o.flag])).toEqual([
        ['Hemoglobin', 'normal'],
        ['Platelets', 'critical'],
      ]);
      expect(detail.observations[1]).toMatchObject({
        value: '40',
        unit: '10*3/uL',
        referenceRange: '150-400',
        interpretation: 'LL',
      });
      expect(detail.patientName).toBe('Aisha Rahman');
    });

    it('raises one alert per critical observation, linked to its report', async () => {
      const { service } = await seed();
      const { items } = await service.critical({}, ACTOR, NOW);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        display: 'Platelets',
        interpretation: 'LL',
        patientName: 'Aisha Rahman',
        mrn: 'T1-00001',
      });
      const [report] = (await service.list({ criticalOnly: true }, ACTOR))
        .items;
      expect(items[0].reportId).toBe(report.id);
    });

    it('leaves out critical observations older than the window', async () => {
      const { service } = await seed();
      const later = new Date('2026-11-30T00:00:00.000Z');
      expect((await service.critical({}, ACTOR, later)).items).toHaveLength(0);
    });
  });
});
