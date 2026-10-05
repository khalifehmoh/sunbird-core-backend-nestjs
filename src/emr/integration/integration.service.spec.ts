import { BadRequestException, NotFoundException } from '@nestjs/common';
import type {
  Appointment,
  DiagnosticReport,
  Observation,
  ServiceRequest,
} from '@medplum/fhirtypes';
import { EmrEventBus, type EmrEvent } from '../emr-events';
import { ORDER_NUMBER_SYSTEM } from '../emr.constants';
import { AppointmentsService } from '../appointments/appointments.service';
import { OrdersService } from '../orders/orders.service';
import { ResultsService } from '../results/results.service';
import type { SequenceService } from '../sequence.service';
import { ACTOR, buildHarness, patient } from '../testing/harness';
import { InMemoryMessageStore } from '../testing/in-memory-message-store';
import { integrationKeyMatches } from './integration-key';
import { IntegrationService } from './integration.service';
import { parseHl7 } from './hl7';
import {
  mapOrm,
  mapOru,
  mapSiuBooking,
  mapSiuCancellation,
} from './hl7-mappers';

const TENANT = ACTOR.tenantId;
// 2026-10-04 is a Sunday inside clinic hours; `NOW` is before it.
const NOW = new Date('2026-10-01T06:00:00.000Z');

const hl7 = (...segments: string[]) => segments.join('\r');

const oru = (controlId = 'MSG-100', flag = 'LL') =>
  hl7(
    `MSH|^~\\&|LAB|CENTRAL|SUNBIRD|EMR|20261006120000||ORU^R01|${controlId}|P|2.5`,
    'PID|1||T1-00001^^^HOSP^MR||Rahman^Aisha',
    'OBR|1|ORD-2026-00001||58410-2^CBC panel^LN|||20261006113000|||||||||||||||20261006120000|||F',
    `OBX|1|NM|777-3^Platelets^LN||40|10*3/uL|150-400|${flag}|||F|||20261006113000`,
    'NTE|1||Recheck in 24 hours',
  );

const orm = (control: string, number = 'EXT-ORD-1') =>
  hl7(
    'MSH|^~\\&|CPOE|CENTRAL|SUNBIRD|EMR|20261006120000||ORM^O01|ORM-1|P|2.5',
    'PID|1||T1-00001^^^HOSP^MR',
    `ORC|${control}|${number}`,
    'OBR|1|' + number + '||718-7^Hemoglobin^LN|S',
  );

const siu = (trigger: string, id = 'EXT-77') =>
  hl7(
    `MSH|^~\\&|SCHED|CENTRAL|SUNBIRD|EMR|20260930120000||SIU^${trigger}|SIU-${trigger}|P|2.5`,
    `SCH|${id}||||||Follow-up^Follow-up visit||30|min|^^^20261004090000`,
    'PID|1||T1-00001^^^HOSP^MR',
    'AIP|1||doc-1^Nasser^Layla',
  );

function build() {
  const harness = buildHarness();
  harness.store.seed<ServiceRequest>({
    resourceType: 'ServiceRequest',
    id: 'sr-1',
    status: 'active',
    intent: 'order',
    identifier: [{ system: ORDER_NUMBER_SYSTEM, value: 'ORD-2026-00001' }],
    subject: { reference: 'Patient/patient-1' },
  });
  harness.store.seed({ resourceType: 'Practitioner', id: 'doc-1' });

  const bus = new EmrEventBus();
  const events: EmrEvent[] = [];
  bus.subscribe((event) => {
    events.push(event);
  });
  let counter = 0;
  const sequences = {
    next: () => Promise.resolve(++counter),
  } as unknown as SequenceService;
  const messages = new InMemoryMessageStore();
  const service = new IntegrationService(
    messages,
    harness.fhir,
    new ResultsService(harness.fhir, bus),
    new OrdersService(harness.fhir, sequences, bus),
    new AppointmentsService(harness.fhir, bus),
    bus,
  );
  return { ...harness, messages, service, events };
}

describe('HL7 mappers', () => {
  it('maps an ORU into one result group per OBR', () => {
    const parsed = mapOru(parseHl7(oru()));

    expect(parsed.mrn).toBe('T1-00001');
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]).toMatchObject({
      controlId: 'MSG-100',
      orderNumber: 'ORD-2026-00001',
      code: '58410-2',
      type: 'LAB',
      conclusion: 'Recheck in 24 hours',
      issuedAt: '2026-10-06T09:00:00.000Z',
    });
    expect(parsed.groups[0].observations[0]).toMatchObject({
      code: '777-3',
      value: '40',
      unit: '10*3/uL',
      flag: 'LL',
      status: 'F',
    });
  });

  it('gives later groups their own control id so each stays idempotent', () => {
    const raw = hl7(
      'MSH|^~\\&|LAB|C|S|E|20261006||ORU^R01|M1|P|2.5',
      'PID|1||T1-00001^^^H^MR',
      'OBR|1|||A^First^LN',
      'OBX|1|NM|1-1^X^LN||1',
      'OBR|2|||B^Second^LN',
      'OBX|1|NM|2-2^Y^LN||2',
    );

    expect(mapOru(parseHl7(raw)).groups.map((g) => g.controlId)).toEqual([
      'M1',
      'M1#2',
    ]);
  });

  it('prefers the MR identifier in PID-3 over other identifiers', () => {
    const raw = hl7(
      'MSH|^~\\&|LAB|C|S|E|20261006||ORU^R01|M1|P|2.5',
      'PID|1||NAT123^^^GOV^NI~T1-00009^^^H^MR',
      'OBR|1|||A^First^LN',
      'OBX|1|NM|1-1^X^LN||1',
    );

    expect(mapOru(parseHl7(raw)).mrn).toBe('T1-00009');
  });

  it('reports what is missing', () => {
    const noPid = hl7('MSH|^~\\&|A|B|C|D|20261006||ORU^R01|M1|P|2.5', 'OBR|1');
    expect(() => mapOru(parseHl7(noPid))).toThrow(/PID/);

    const noObr = hl7(
      'MSH|^~\\&|A|B|C|D|20261006||ORU^R01|M1|P|2.5',
      'PID|1||T1-00001^^^H^MR',
    );
    expect(() => mapOru(parseHl7(noObr))).toThrow(/OBR/);
  });

  it('maps order control codes and STAT priority', () => {
    expect(mapOrm(parseHl7(orm('NW')))).toMatchObject({
      control: 'NW',
      orderNumber: 'EXT-ORD-1',
      code: '718-7',
      priority: 'STAT',
    });
    expect(mapOrm(parseHl7(orm('CA'))).control).toBe('CA');
    expect(() => mapOrm(parseHl7(orm('XX')))).toThrow(/not supported/);
  });

  it('maps a booking and a cancellation', () => {
    expect(mapSiuBooking(parseHl7(siu('S12')))).toMatchObject({
      externalId: 'EXT-77',
      mrn: 'T1-00001',
      practitionerId: 'doc-1',
      start: '2026-10-04T06:00:00.000Z',
      durationMinutes: 30,
      reason: 'Follow-up visit',
    });
    expect(mapSiuCancellation(parseHl7(siu('S14'))).externalId).toBe('EXT-77');
  });
});

describe('integrationKeyMatches', () => {
  it('matches only the exact key, and never when none is configured', () => {
    expect(integrationKeyMatches('secret-key', 'secret-key')).toBe(true);
    expect(integrationKeyMatches('secret-key', 'secret-kez')).toBe(false);
    expect(integrationKeyMatches('secret-key', 'short')).toBe(false);
    expect(integrationKeyMatches('secret-key', undefined)).toBe(false);
    expect(integrationKeyMatches('', '')).toBe(false);
    expect(integrationKeyMatches(undefined, 'x')).toBe(false);
  });
});

describe('IntegrationService', () => {
  describe('ingest', () => {
    it('stores a result, walks every stage and acknowledges with AA', async () => {
      const { service, store, messages, events } = build();

      const outcome = await service.ingest(TENANT, oru(), 'HL7', NOW);

      expect(outcome).toMatchObject({ status: 'PROCESSED', ackCode: 'AA' });
      expect(outcome.ack).toContain('MSA|AA|MSG-100|');
      expect(store.all<DiagnosticReport>('DiagnosticReport')).toHaveLength(1);
      expect(store.all<Observation>('Observation')).toHaveLength(1);
      expect(messages.transactions.map((t) => t.stage)).toEqual([
        'RECEIVED',
        'PARSED',
        'ROUTED',
        'PROCESSED',
        'ACKNOWLEDGED',
      ]);
      expect(messages.messages[0]).toMatchObject({
        status: 'PROCESSED',
        messageType: 'ORU^R01',
        controlId: 'MSG-100',
        attempts: 1,
      });
      expect(messages.acks).toHaveLength(1);
      expect(events.some((e) => e.channel === 'emr.oru')).toBe(true);
      expect(outcome.detail).toContain('1 report(s) stored');
      expect(outcome.detail).toContain('1 critical');
    });

    it('treats a redelivered message as already received', async () => {
      const { service, store } = build();
      await service.ingest(TENANT, oru(), 'HL7', NOW);

      const again = await service.ingest(TENANT, oru(), 'HL7', NOW);

      expect(again).toMatchObject({ status: 'PROCESSED', ackCode: 'AA' });
      expect(again.detail).toContain('already received');
      expect(store.all('DiagnosticReport')).toHaveLength(1);
    });

    it('rejects text that is not HL7 with AR and records the error', async () => {
      const { service, messages } = build();

      const outcome = await service.ingest(TENANT, 'hello world', 'HL7', NOW);

      expect(outcome).toMatchObject({ status: 'FAILED', ackCode: 'AR' });
      expect(messages.errors[0]).toMatchObject({
        stage: 'PARSED',
        errorCode: 'INVALID_HL7',
      });
      expect(messages.messages[0].status).toBe('FAILED');
    });

    it('rejects a message type it does not handle with AR', async () => {
      const { service, messages } = build();
      const adt = hl7(
        'MSH|^~\\&|HIS|C|S|E|20261006||ADT^A01|ADT-1|P|2.5',
        'PID|1||T1-00001^^^H^MR',
      );

      const outcome = await service.ingest(TENANT, adt, 'HL7', NOW);

      expect(outcome).toMatchObject({ status: 'FAILED', ackCode: 'AR' });
      expect(messages.errors[0].errorCode).toBe('UNSUPPORTED_MESSAGE_TYPE');
      // Parsing worked, so the type is still shown in the monitor.
      expect(messages.messages[0].messageType).toBe('ADT^A01');
    });

    it('answers AE when the patient is unknown', async () => {
      const { service, messages, events } = build();
      const raw = oru().replace('T1-00001', 'T1-99999');

      const outcome = await service.ingest(TENANT, raw, 'HL7', NOW);

      expect(outcome).toMatchObject({ status: 'FAILED', ackCode: 'AE' });
      expect(messages.errors[0].errorCode).toBe('PATIENT_NOT_FOUND');
      expect(events.find((e) => e.channel === 'emr.error')).toMatchObject({
        event: 'PATIENT_NOT_FOUND',
      });
    });

    it('does not leak internal failures to the sender', async () => {
      const { service, fhir, messages } = build();
      jest
        .spyOn(fhir, 'findPatientIdByMrn')
        .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:8103'));

      const outcome = await service.ingest(TENANT, oru(), 'HL7', NOW);

      expect(outcome).toMatchObject({ status: 'FAILED', ackCode: 'AE' });
      expect(outcome.ack).not.toContain('ECONNREFUSED');
      expect(messages.errors[0].errorCode).toBe('INTERNAL_ERROR');
      expect(messages.errors[0].errorMessage).not.toContain('ECONNREFUSED');
    });

    it('refuses an empty or oversized body outright', async () => {
      const { service, messages } = build();

      await expect(
        service.ingest(TENANT, '  ', 'HL7', NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.ingest(TENANT, 'x'.repeat(300 * 1024), 'HL7', NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(messages.messages).toHaveLength(0);
    });
  });

  describe('orders', () => {
    it("creates an order keeping the sender's number, once", async () => {
      const { service, store } = build();

      const first = await service.ingest(TENANT, orm('NW'), 'HL7', NOW);
      const again = await service.ingest(TENANT, orm('NW'), 'HL7', NOW);

      expect(first.detail).toBe('Order EXT-ORD-1 created');
      expect(again.detail).toBe('Order EXT-ORD-1 already exists');
      const orders = store
        .all<ServiceRequest>('ServiceRequest')
        .filter((o) => o.identifier?.[0]?.value === 'EXT-ORD-1');
      expect(orders).toHaveLength(1);
      expect(orders[0].priority).toBe('stat');
    });

    it('cancels an order and ignores a repeated cancel', async () => {
      const { service, store } = build();
      await service.ingest(TENANT, orm('NW'), 'HL7', NOW);

      const first = await service.ingest(TENANT, orm('CA'), 'HL7', NOW);
      const again = await service.ingest(TENANT, orm('CA'), 'HL7', NOW);

      expect(first.detail).toBe('Order EXT-ORD-1 cancelled');
      expect(again.detail).toBe('Order EXT-ORD-1 was already cancelled');
      expect(
        store
          .all<ServiceRequest>('ServiceRequest')
          .find((o) => o.identifier?.[0]?.value === 'EXT-ORD-1')?.status,
      ).toBe('revoked');
    });

    it('fails a cancel for an order that does not exist', async () => {
      const { service, messages } = build();

      const outcome = await service.ingest(
        TENANT,
        orm('CA', 'NOPE'),
        'HL7',
        NOW,
      );

      expect(outcome.ackCode).toBe('AE');
      expect(messages.errors[0].errorCode).toBe('ORDER_NOT_FOUND');
    });
  });

  describe('scheduling', () => {
    it("books and cancels an appointment by the sender's id", async () => {
      const { service, store } = build();

      const booked = await service.ingest(TENANT, siu('S12'), 'HL7', NOW);
      const cancelled = await service.ingest(TENANT, siu('S14'), 'HL7', NOW);

      expect(booked.detail).toBe('Appointment EXT-77 booked');
      expect(cancelled.detail).toBe('Appointment EXT-77 cancelled');
      expect(store.all<Appointment>('Appointment')).toHaveLength(1);
      expect(store.all<Appointment>('Appointment')[0].status).toBe('cancelled');
    });

    it('accepts S15 as a cancellation as well', async () => {
      const { service } = build();
      await service.ingest(TENANT, siu('S12'), 'HL7', NOW);

      const outcome = await service.ingest(TENANT, siu('S15'), 'HL7', NOW);

      expect(outcome.status).toBe('PROCESSED');
    });

    it('reports a taken slot as an application error', async () => {
      const { service, messages } = build();
      await service.ingest(TENANT, siu('S12', 'EXT-1'), 'HL7', NOW);

      const outcome = await service.ingest(
        TENANT,
        siu('S12', 'EXT-2'),
        'HL7',
        NOW,
      );

      expect(outcome.ackCode).toBe('AE');
      expect(messages.errors.at(-1)?.errorCode).toBe('SLOT_UNAVAILABLE');
    });
  });

  describe('retry', () => {
    it('replays a failed message once the cause is fixed', async () => {
      const { service, store, messages } = build();
      const raw = oru('MSG-200')
        .replace('T1-00001', 'T1-00077')
        .replace('ORD-2026-00001', '');
      const failed = await service.ingest(TENANT, raw, 'HL7', NOW);
      expect(failed.status).toBe('FAILED');

      store.seed(patient('patient-77', 'T1-00077', 'Sara Ali'));
      const outcome = await service.retry(
        TENANT,
        failed.messageId,
        'user-1',
        NOW,
      );

      expect(outcome).toMatchObject({ status: 'PROCESSED', ackCode: 'AA' });
      expect(messages.messages[0]).toMatchObject({
        status: 'PROCESSED',
        attempts: 2,
      });
      expect(messages.retries).toEqual([
        expect.objectContaining({ outcome: 'SUCCESS', requestedBy: 'user-1' }),
      ]);
      expect(messages.errors).toHaveLength(1); // history of the first failure stays
      const seqs = messages.transactions.map((t) => t.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
    });
    it('records a failed retry and leaves the message failed', async () => {
      const { service, messages } = build();
      const raw = oru('MSG-201').replace('T1-00001', 'T1-00077');
      const failed = await service.ingest(TENANT, raw, 'HL7', NOW);

      const outcome = await service.retry(TENANT, failed.messageId, null, NOW);

      expect(outcome.status).toBe('FAILED');
      expect(messages.retries[0].outcome).toBe('FAILED');
      expect(messages.messages[0].attempts).toBe(2);
    });

    it('only retries failed messages, within the tenant', async () => {
      const { service } = build();
      const ok = await service.ingest(TENANT, oru(), 'HL7', NOW);

      await expect(
        service.retry(TENANT, ok.messageId, null, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.retry('other-tenant', ok.messageId, null, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('monitor', () => {
    it("lists messages with the failure reason and today's KPIs", async () => {
      const { service } = build();
      await service.ingest(TENANT, oru(), 'HL7', NOW);
      await service.ingest(TENANT, 'garbage', 'HL7', NOW);
      await service.ingest(TENANT, orm('CA', 'NOPE'), 'HL7', NOW);

      const { items, kpis } = await service.list(TENANT, {}, new Date());

      expect(items).toHaveLength(3);
      const failed = items.filter((i) => i.status === 'FAILED');
      expect(failed.map((i) => i.lastError?.code).sort()).toEqual([
        'INVALID_HL7',
        'ORDER_NOT_FOUND',
      ]);
      expect(items.find((i) => i.status === 'PROCESSED')?.lastError).toBeNull();
      expect(kpis.received).toBeGreaterThanOrEqual(0);
    });

    it('filters by status, type and control id', async () => {
      const { service } = build();
      await service.ingest(TENANT, oru('AAA-1'), 'HL7', NOW);
      await service.ingest(TENANT, orm('NW'), 'HL7', NOW);

      expect(
        (await service.list(TENANT, { messageType: 'ORU^R01' })).items,
      ).toHaveLength(1);
      expect((await service.list(TENANT, { q: 'aaa' })).items).toHaveLength(1);
      expect(
        (await service.list(TENANT, { status: 'FAILED' })).items,
      ).toHaveLength(0);
      expect((await service.list('other-tenant', {})).items).toHaveLength(0);
    });

    it('returns full detail for one message, including the ACK sent', async () => {
      const { service } = build();
      const outcome = await service.ingest(TENANT, oru(), 'HL7', NOW);

      const detail = await service.get(TENANT, outcome.messageId);

      expect(detail.rawMessage).toContain('ORU^R01');
      expect(detail.stages).toHaveLength(5);
      expect(detail.acks[0].raw).toContain('MSA|AA');
      await expect(
        service.get('other-tenant', outcome.messageId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('computes the failure rate and per-type breakdown for the window', async () => {
      const { service, messages } = build();
      await service.ingest(TENANT, oru(), 'HL7', NOW);
      await service.ingest(TENANT, 'garbage', 'HL7', NOW);
      // The in-memory clock sits on 2026-10-06; look at that day.
      const stats = await service.stats(
        TENANT,
        new Date('2026-10-06T10:00:00.000Z'),
      );

      expect(messages.messages).toHaveLength(2);
      expect(stats).toMatchObject({ received: 2, processed: 1, failed: 1 });
      expect(stats.failureRatePercent).toBe(50);
      expect(stats.byType).toEqual(
        expect.arrayContaining([
          { messageType: 'ORU^R01', count: 1, failed: 0 },
          { messageType: 'UNKNOWN', count: 1, failed: 1 },
        ]),
      );
      expect(stats.recentErrors[0]).toMatchObject({ code: 'INVALID_HL7' });
    });
  });
});
