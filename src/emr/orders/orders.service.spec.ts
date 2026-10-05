import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ServiceRequest } from '@medplum/fhirtypes';
import { EmrEventBus, type EmrEvent } from '../emr-events';
import { ORDER_NUMBER_SYSTEM, ORM_EVENT_SYSTEM } from '../emr.constants';
import type { SequenceService } from '../sequence.service';
import { ACTOR, buildHarness, encounter } from '../testing/harness';
import { OrdersService } from './orders.service';

const NOW = new Date('2026-10-06T09:00:00.000Z');

function build() {
  const harness = buildHarness();
  harness.store.seed(encounter('enc-1', 'patient-1'));
  harness.store.seed(encounter('enc-2', 'patient-2'));
  let counter = 0;
  const sequences = {
    next: jest.fn(() => Promise.resolve(++counter)),
  } as unknown as SequenceService;
  const bus = new EmrEventBus();
  const events: EmrEvent[] = [];
  bus.subscribe((event) => {
    events.push(event);
  });
  return {
    ...harness,
    sequences,
    events,
    service: new OrdersService(harness.fhir, sequences, bus),
  };
}

describe('OrdersService', () => {
  describe('create', () => {
    it('creates an active LOINC-coded ServiceRequest with an order number', async () => {
      const { store, service, events } = build();

      const row = await service.create(
        {
          patientId: 'patient-1',
          encounterId: 'enc-1',
          type: 'LAB',
          code: '58410-2',
          priority: 'STAT',
          notes: 'Fasting',
        },
        ACTOR,
        NOW,
      );

      expect(row).toMatchObject({
        orderNumber: 'ORD-2026-00001',
        type: 'LAB',
        code: '58410-2',
        display: 'CBC panel - Blood by Automated count',
        priority: 'STAT',
        status: 'active',
        patientId: 'patient-1',
        patientName: 'Aisha Rahman',
        mrn: 'T1-00001',
        encounterId: 'enc-1',
        notes: 'Fasting',
      });
      const [saved] = store.all<ServiceRequest>('ServiceRequest');
      expect(saved).toMatchObject({
        status: 'active',
        intent: 'order',
        priority: 'stat',
        requester: { reference: 'Practitioner/prac-1' },
        authoredOn: NOW.toISOString(),
      });
      expect(saved.identifier?.[0]).toEqual({
        system: ORDER_NUMBER_SYSTEM,
        value: 'ORD-2026-00001',
      });
      expect(events.map((e) => [e.channel, e.event])).toEqual([
        ['emr.orm', 'O01'],
      ]);
    });

    it('numbers orders per year from the sequence', async () => {
      const { sequences, service } = build();
      await service.create(
        { patientId: 'patient-1', type: 'RAD', code: '36643-5' },
        ACTOR,
        NOW,
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(sequences.next).toHaveBeenCalledWith('tenant-1', 'order:2026');
    });

    it('accepts a code outside the catalog when a display is given', async () => {
      const { service } = build();
      const row = await service.create(
        {
          patientId: 'patient-1',
          type: 'LAB',
          code: '2857-1',
          display: 'PSA [Mass/volume] in Serum or Plasma',
        },
        ACTOR,
        NOW,
      );
      expect(row.display).toBe('PSA [Mass/volume] in Serum or Plasma');
      expect(row.priority).toBe('ROUTINE');
    });

    it('requires a display for a code outside the catalog', async () => {
      const { store, service } = build();
      await expect(
        service.create(
          { patientId: 'patient-1', type: 'LAB', code: '2857-1' },
          ACTOR,
          NOW,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(store.all('ServiceRequest')).toHaveLength(0);
    });

    it('rejects a catalog code ordered as the wrong type', async () => {
      const { service } = build();
      await expect(
        service.create(
          { patientId: 'patient-1', type: 'RAD', code: '58410-2' },
          ACTOR,
          NOW,
        ),
      ).rejects.toThrow('is a LAB code');
    });

    it('rejects an encounter that belongs to another patient', async () => {
      const { sequences, service } = build();
      await expect(
        service.create(
          {
            patientId: 'patient-1',
            encounterId: 'enc-2',
            type: 'LAB',
            code: '718-7',
          },
          ACTOR,
          NOW,
        ),
      ).rejects.toThrow('does not belong');
      // No number is spent on an order that fails validation.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(sequences.next).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    async function seed() {
      const harness = build();
      const make = (
        patientId: string,
        type: 'LAB' | 'RAD',
        code: string,
        priority: 'ROUTINE' | 'STAT',
        at: string,
      ) =>
        harness.service.create(
          { patientId, type, code, priority },
          ACTOR,
          new Date(at),
        );
      await make(
        'patient-1',
        'LAB',
        '718-7',
        'ROUTINE',
        '2026-10-01T08:00:00Z',
      );
      await make('patient-1', 'RAD', '36643-5', 'STAT', '2026-10-02T08:00:00Z');
      await make('patient-2', 'LAB', '2160-0', 'STAT', '2026-10-03T08:00:00Z');
      return harness;
    }

    it('returns newest first with patient names', async () => {
      const { service } = await seed();
      const { items } = await service.list({}, ACTOR);
      expect(items.map((o) => o.orderNumber)).toEqual([
        'ORD-2026-00003',
        'ORD-2026-00002',
        'ORD-2026-00001',
      ]);
      expect(items[0].patientName).toBe('Omar Said');
    });

    it('filters by type, priority and patient', async () => {
      const { service } = await seed();
      expect(
        (await service.list({ type: 'RAD' }, ACTOR)).items.map((o) => o.code),
      ).toEqual(['36643-5']);
      expect(
        (await service.list({ priority: 'STAT' }, ACTOR)).items,
      ).toHaveLength(2);
      expect(
        (await service.list({ patientId: 'patient-2' }, ACTOR)).items,
      ).toHaveLength(1);
    });

    it('filters by authored date range', async () => {
      const { service } = await seed();
      const { items } = await service.list(
        { from: '2026-10-02T00:00:00Z', to: '2026-10-03T00:00:00Z' },
        ACTOR,
      );
      expect(items.map((o) => o.orderNumber)).toEqual(['ORD-2026-00002']);
    });
  });

  describe('cancel', () => {
    it('revokes an active order, keeps the reason and announces O01-CANCEL', async () => {
      const { store, service, events } = build();
      const order = await service.create(
        { patientId: 'patient-1', type: 'LAB', code: '718-7' },
        ACTOR,
        NOW,
      );

      const row = await service.cancel(order.id, 'Duplicate order', ACTOR);

      expect(row.status).toBe('revoked');
      const saved = store.get<ServiceRequest>(`ServiceRequest/${order.id}`);
      expect(saved.status).toBe('revoked');
      expect(saved.note?.map((n) => n.text)).toContain(
        'Cancelled: Duplicate order',
      );
      expect(
        saved.meta?.tag?.filter((t) => t.system === ORM_EVENT_SYSTEM),
      ).toEqual([{ system: ORM_EVENT_SYSTEM, code: 'O01-CANCEL' }]);
      expect(events.at(-1)).toMatchObject({
        channel: 'emr.orm',
        event: 'O01-CANCEL',
      });
    });

    it('does not cancel a completed or already-cancelled order', async () => {
      const { store, service } = build();
      const order = await service.create(
        { patientId: 'patient-1', type: 'LAB', code: '718-7' },
        ACTOR,
        NOW,
      );
      await service.cancel(order.id, 'Entered by mistake', ACTOR);
      await expect(service.cancel(order.id, 'again', ACTOR)).rejects.toThrow(
        'revoked order cannot be cancelled',
      );

      const completed = store.seed<ServiceRequest>({
        resourceType: 'ServiceRequest',
        id: 'sr-done',
        status: 'completed',
        intent: 'order',
        subject: { reference: 'Patient/patient-1' },
      });
      await expect(
        service.cancel(completed.id, 'too late', ACTOR),
      ).rejects.toThrow(BadRequestException);
    });

    it('answers 409 when the order changed after it was read', async () => {
      const { store, service } = build();
      const order = await service.create(
        { patientId: 'patient-1', type: 'LAB', code: '718-7' },
        ACTOR,
        NOW,
      );
      store.beforeNextTransaction = () =>
        store.touch(`ServiceRequest/${order.id}`);

      await expect(
        service.cancel(order.id, 'Duplicate order', ACTOR),
      ).rejects.toThrow(ConflictException);
      expect(
        store.get<ServiceRequest>(`ServiceRequest/${order.id}`).status,
      ).toBe('active');
    });
  });
});
