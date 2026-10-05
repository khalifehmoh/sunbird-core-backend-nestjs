import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Appointment } from '@medplum/fhirtypes';
import { EmrEventBus, type EmrEvent } from '../emr-events';
import { APPOINTMENT_SLOT_SYSTEM } from '../emr.constants';
import { ACTOR, buildHarness } from '../testing/harness';
import { AppointmentsService } from './appointments.service';
import { localMidnight } from './scheduling';

// 2026-10-04 is a Sunday; the clinic opens 08:00 local (UTC+3).
const NOW = new Date('2026-10-01T06:00:00.000Z');
const at = (date: string, hhmm: string) =>
  new Date(
    localMidnight(date) +
      (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) * 60_000,
  ).toISOString();

function build() {
  const harness = buildHarness();
  harness.store.seed({
    resourceType: 'Practitioner',
    id: 'doc-1',
    name: [{ given: ['Layla'], family: 'Nasser', prefix: ['Dr.'] }],
  });
  harness.store.seed({ resourceType: 'Practitioner', id: 'doc-2' });
  const bus = new EmrEventBus();
  const events: EmrEvent[] = [];
  bus.subscribe((event) => {
    events.push(event);
  });
  return {
    ...harness,
    events,
    service: new AppointmentsService(harness.fhir, bus),
  };
}

const booking = (start: string, overrides = {}) => ({
  patientId: 'patient-1',
  practitionerId: 'doc-1',
  start,
  ...overrides,
});

describe('AppointmentsService', () => {
  describe('providers', () => {
    it('lists practitioners by name for the picker', async () => {
      const { service } = build();

      const { items } = await service.providers(ACTOR);

      expect(items.map((p) => p.id).sort()).toEqual([
        'doc-1',
        'doc-2',
        'prac-1',
      ]);
      expect(items.find((p) => p.id === 'doc-1')?.name).toBe(
        'Dr. Layla Nasser',
      );
      // Falls back to the id when a practitioner has no name.
      expect(items.find((p) => p.id === 'doc-2')?.name).toBe('doc-2');
    });
  });

  describe('book (S12)', () => {
    it('creates a booked appointment for the patient and provider', async () => {
      const { store, service, events } = build();

      const row = await service.book(
        booking(at('2026-10-04', '09:00'), {
          durationMinutes: 60,
          type: 'FOLLOWUP',
          reason: 'Review labs',
        }),
        ACTOR,
        NOW,
      );

      expect(row).toMatchObject({
        status: 'booked',
        start: '2026-10-04T06:00:00.000Z',
        end: '2026-10-04T07:00:00.000Z',
        durationMinutes: 60,
        type: 'FOLLOWUP',
        reason: 'Review labs',
        patientName: 'Aisha Rahman',
        mrn: 'T1-00001',
        practitionerId: 'doc-1',
        practitionerName: 'Layla Nasser',
      });
      const [saved] = store.all<Appointment>('Appointment');
      expect(saved.participant.map((p) => p.actor?.reference)).toEqual([
        'Patient/patient-1',
        'Practitioner/doc-1',
      ]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        channel: 'emr.sch',
        event: 'S12',
        patientId: 'patient-1',
        data: { practitioner: 'Layla Nasser' },
      });
    });

    it('refuses a time that overlaps an existing booking for the same provider', async () => {
      const { store, service } = build();
      await service.book(
        booking(at('2026-10-04', '09:00'), { durationMinutes: 60 }),
        ACTOR,
        NOW,
      );

      await expect(
        service.book(
          booking(at('2026-10-04', '09:30'), { patientId: 'patient-2' }),
          ACTOR,
          NOW,
        ),
      ).rejects.toThrow(ConflictException);
      expect(store.all('Appointment')).toHaveLength(1);
    });

    it('lets another provider take the same time', async () => {
      const { service } = build();
      await service.book(booking(at('2026-10-04', '09:00')), ACTOR, NOW);
      await expect(
        service.book(
          booking(at('2026-10-04', '09:00'), {
            practitionerId: 'doc-2',
            patientId: 'patient-2',
          }),
          ACTOR,
          NOW,
        ),
      ).resolves.toMatchObject({ practitionerId: 'doc-2' });
    });

    it('lets the next slot follow without overlap', async () => {
      const { service } = build();
      await service.book(booking(at('2026-10-04', '09:00')), ACTOR, NOW);
      await expect(
        service.book(
          booking(at('2026-10-04', '09:30'), { patientId: 'patient-2' }),
          ACTOR,
          NOW,
        ),
      ).resolves.toBeDefined();
    });

    it('gives the slot to exactly one of two simultaneous requests', async () => {
      const { store, service } = build();
      const results = await Promise.allSettled([
        service.book(booking(at('2026-10-04', '10:00')), ACTOR, NOW),
        service.book(
          booking(at('2026-10-04', '10:00'), { patientId: 'patient-2' }),
          ACTOR,
          NOW,
        ),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        reason: expect.any(ConflictException),
      });
      expect(store.all('Appointment')).toHaveLength(1);
    });

    it('refuses the slot when another instance takes it after the check', async () => {
      const { store, service } = build();
      const start = at('2026-10-04', '11:00');
      // Another API instance commits the same provider and start between this
      // request's overlap check and its write; only the conditional create
      // can still notice it.
      store.beforeNextTransaction = () => {
        store.seed<Appointment>({
          resourceType: 'Appointment',
          status: 'booked',
          identifier: [
            { system: APPOINTMENT_SLOT_SYSTEM, value: `doc-1@${start}` },
          ],
          start,
          participant: [
            { actor: { reference: 'Practitioner/doc-1' }, status: 'accepted' },
          ],
        });
      };

      await expect(
        service.book(
          booking(at('2026-10-04', '11:00'), { patientId: 'patient-2' }),
          ACTOR,
          NOW,
        ),
      ).rejects.toThrow(ConflictException);
      expect(store.all('Appointment')).toHaveLength(1);
    });

    it.each([
      ['off the grid', at('2026-10-04', '09:10')],
      ['before opening', at('2026-10-04', '07:30')],
      ['on a closed day (Friday)', at('2026-10-09', '09:00')],
      ['in the past', at('2026-09-27', '09:00')],
    ])('rejects a start %s', async (_label, start) => {
      const { store, service } = build();
      await expect(service.book(booking(start), ACTOR, NOW)).rejects.toThrow(
        BadRequestException,
      );
      expect(store.all('Appointment')).toHaveLength(0);
    });

    it('rejects an appointment that runs past closing time', async () => {
      const { service } = build();
      await expect(
        service.book(
          booking(at('2026-10-04', '15:30'), { durationMinutes: 60 }),
          ACTOR,
          NOW,
        ),
      ).rejects.toThrow('closing');
    });

    it('rejects an unknown provider or an invisible patient', async () => {
      const { store, service } = build();
      await expect(
        service.book(
          booking(at('2026-10-04', '09:00'), { practitionerId: 'nobody' }),
          ACTOR,
          NOW,
        ),
      ).rejects.toThrow(NotFoundException);
      store.hide('Patient/patient-1');
      await expect(
        service.book(booking(at('2026-10-04', '09:00')), ACTOR, NOW),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('slots', () => {
    it('shows booked, free and blocked slots for the week', async () => {
      const { service } = build();
      await service.book(
        booking(at('2026-10-04', '09:00'), { durationMinutes: 60 }),
        ACTOR,
        NOW,
      );

      const { days } = await service.slots(
        { practitionerId: 'doc-1', from: '2026-10-04' },
        ACTOR,
        NOW.getTime(),
      );

      expect(days.map((d) => d.date)).toEqual([
        '2026-10-04',
        '2026-10-05',
        '2026-10-06',
        '2026-10-07',
        '2026-10-08',
        '2026-10-09',
        '2026-10-10',
      ]);
      const sunday = days[0];
      expect(sunday.slots.filter((s) => s.status === 'booked')).toHaveLength(2);
      expect(sunday.slots.filter((s) => s.status === 'free')).toHaveLength(14);
      // Friday and Saturday are closed.
      expect(days[5].working).toBe(false);
      expect(days[6].slots.every((s) => s.status === 'blocked')).toBe(true);
    });

    it('shows a slot booked by someone the caller cannot see', async () => {
      const { store, service } = build();
      await service.book(booking(at('2026-10-04', '09:00')), ACTOR, NOW);
      const [held] = store.all<Appointment>('Appointment');
      store.hide(`Appointment/${held.id}`);

      const { days } = await service.slots(
        { practitionerId: 'doc-1', from: '2026-10-04', days: 1 },
        ACTOR,
        NOW.getTime(),
      );
      expect(days[0].slots.filter((s) => s.status === 'booked')).toHaveLength(
        1,
      );
    });

    it('frees a slot once its appointment is cancelled', async () => {
      const { service } = build();
      const row = await service.book(
        booking(at('2026-10-04', '09:00')),
        ACTOR,
        NOW,
      );
      await service.cancel(row.id, 'Patient request', ACTOR);

      const { days } = await service.slots(
        { practitionerId: 'doc-1', from: '2026-10-04', days: 1 },
        ACTOR,
        NOW.getTime(),
      );
      expect(days[0].slots.filter((s) => s.status === 'booked')).toHaveLength(
        0,
      );

      // ...and the same time can be booked again.
      await expect(
        service.book(
          booking(at('2026-10-04', '09:00'), { patientId: 'patient-2' }),
          ACTOR,
          NOW,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('cancel (S14)', () => {
    it('cancels with a reason and announces S14', async () => {
      const { store, service, events } = build();
      const row = await service.book(
        booking(at('2026-10-04', '09:00')),
        ACTOR,
        NOW,
      );

      const cancelled = await service.cancel(row.id, 'Patient request', ACTOR);

      expect(cancelled).toMatchObject({
        status: 'cancelled',
        cancellationReason: 'Patient request',
      });
      expect(store.get<Appointment>(`Appointment/${row.id}`).status).toBe(
        'cancelled',
      );
      expect(events.at(-1)).toMatchObject({
        channel: 'emr.sch',
        event: 'S14',
        data: { reason: 'Patient request' },
      });
    });

    it('does not cancel twice', async () => {
      const { service } = build();
      const row = await service.book(
        booking(at('2026-10-04', '09:00')),
        ACTOR,
        NOW,
      );
      await service.cancel(row.id, 'x', ACTOR);
      await expect(service.cancel(row.id, 'y', ACTOR)).rejects.toThrow(
        'cancelled appointment cannot be cancelled',
      );
    });

    it('answers 409 when the appointment changed after it was read', async () => {
      const { store, service } = build();
      const row = await service.book(
        booking(at('2026-10-04', '09:00')),
        ACTOR,
        NOW,
      );
      store.beforeNextTransaction = () => store.touch(`Appointment/${row.id}`);
      await expect(
        service.cancel(row.id, 'Patient request', ACTOR),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('noShow', () => {
    it('marks a past booked appointment as a no-show', async () => {
      const { service } = build();
      const row = await service.book(
        booking(at('2026-10-04', '09:00')),
        ACTOR,
        NOW,
      );
      const after = new Date('2026-10-04T08:00:00.000Z');
      await expect(service.noShow(row.id, ACTOR, after)).resolves.toMatchObject(
        {
          status: 'noshow',
        },
      );
    });

    it('refuses before the appointment starts', async () => {
      const { service } = build();
      const row = await service.book(
        booking(at('2026-10-04', '09:00')),
        ACTOR,
        NOW,
      );
      await expect(service.noShow(row.id, ACTOR, NOW)).rejects.toThrow(
        'not started',
      );
    });
  });

  describe('list', () => {
    it('lists upcoming appointments with names, filtered by provider and status', async () => {
      const { service } = build();
      await service.book(booking(at('2026-10-05', '09:00')), ACTOR, NOW);
      await service.book(
        booking(at('2026-10-04', '09:00'), {
          patientId: 'patient-2',
          practitionerId: 'doc-2',
        }),
        ACTOR,
        NOW,
      );
      const second = await service.book(
        booking(at('2026-10-04', '10:00')),
        ACTOR,
        NOW,
      );
      await service.cancel(second.id, 'x', ACTOR);

      const all = await service.list({}, ACTOR);
      expect(all.items.map((a) => a.start)).toEqual([
        at('2026-10-04', '09:00'),
        at('2026-10-04', '10:00'),
        at('2026-10-05', '09:00'),
      ]);
      expect(
        (await service.list({ practitionerId: 'doc-1' }, ACTOR)).items,
      ).toHaveLength(2);
      expect(
        (await service.list({ status: 'cancelled' }, ACTOR)).items,
      ).toHaveLength(1);
      expect(
        (await service.list({ patientId: 'patient-2' }, ACTOR)).items[0],
      ).toMatchObject({ patientName: 'Omar Said' });
      expect(
        (
          await service.list(
            { from: at('2026-10-05', '00:00'), to: at('2026-10-06', '00:00') },
            ACTOR,
          )
        ).items,
      ).toHaveLength(1);
    });
  });

  describe('inbound (SIU)', () => {
    const inbound = {
      externalId: 'EXT-77',
      patientId: 'patient-1',
      practitionerId: 'doc-1',
      start: at('2026-10-04', '09:00'),
      durationMinutes: 30,
    };

    it('books an external appointment once and ignores redelivery', async () => {
      const { store, service } = build();
      const first = await service.bookInbound(inbound, ACTOR.tenantId, NOW);
      const again = await service.bookInbound(inbound, ACTOR.tenantId, NOW);

      expect(first.duplicate).toBe(false);
      expect(again).toEqual({
        appointmentId: first.appointmentId,
        duplicate: true,
      });
      expect(store.all('Appointment')).toHaveLength(1);
    });

    it('turns a taken slot into a processing error', async () => {
      const { service } = build();
      await service.book(booking(at('2026-10-04', '09:00')), ACTOR, NOW);
      await expect(
        service.bookInbound(inbound, ACTOR.tenantId, NOW),
      ).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    });

    it('turns an unknown provider into a processing error', async () => {
      const { service } = build();
      await expect(
        service.bookInbound(
          { ...inbound, practitionerId: 'ghost' },
          ACTOR.tenantId,
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
    });

    it('cancels by external id and ignores a repeated cancel', async () => {
      const { service } = build();
      const booked = await service.bookInbound(inbound, ACTOR.tenantId, NOW);

      const first = await service.cancelInbound(
        'EXT-77',
        'No longer needed',
        ACTOR.tenantId,
      );
      const again = await service.cancelInbound(
        'EXT-77',
        'No longer needed',
        ACTOR.tenantId,
      );

      expect(first).toEqual({
        appointmentId: booked.appointmentId,
        duplicate: false,
      });
      expect(again.duplicate).toBe(true);
    });

    it('rejects a cancel for an unknown external id', async () => {
      const { service } = build();
      await expect(
        service.cancelInbound('EXT-404', 'x', ACTOR.tenantId),
      ).rejects.toMatchObject({ code: 'APPOINTMENT_NOT_FOUND' });
    });
  });
});
