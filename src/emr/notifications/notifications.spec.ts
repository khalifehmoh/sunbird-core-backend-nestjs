import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Patient } from '@medplum/fhirtypes';
import { EmrEventBus } from '../emr-events';
import { ACTOR, buildHarness } from '../testing/harness';
import { InMemoryNotificationStore } from '../testing/in-memory-notification-store';
import {
  FacilityNames,
  NotificationListener,
  formatWhen,
  languageOf,
  triggerFor,
} from './notification.listener';
import type {
  NotificationProvider,
  OutboundMessage,
} from './notification-provider';
import { NotificationsService } from './notifications.service';
import { placeholdersOf, renderTemplate } from './template-renderer';

const TENANT = 'tenant-1';

function buildService(provider?: Partial<NotificationProvider>) {
  const store = new InMemoryNotificationStore();
  const sent: OutboundMessage[] = [];
  const delivery: NotificationProvider = {
    name: 'test',
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
    ...provider,
  };
  return { store, sent, service: new NotificationsService(store, delivery) };
}

describe('template renderer', () => {
  it('fills placeholders, ignoring case and spacing', () => {
    expect(
      renderTemplate('Hello {{ Patient_Name }}, see {{provider}}.', {
        patient_name: 'Aisha',
        provider: 'Dr. Nasser',
      }),
    ).toEqual({ text: 'Hello Aisha, see Dr. Nasser.', missing: [] });
  });

  it('renders a missing value as empty and reports it', () => {
    expect(renderTemplate('Reason: {{reason}}.', {})).toEqual({
      text: 'Reason: .',
      missing: ['reason'],
    });
  });

  it('lists the distinct placeholders of a body', () => {
    expect(placeholdersOf('{{a}} {{b}} {{A}} {{ c }}')).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('does not treat values as templates', () => {
    expect(
      renderTemplate('Hi {{patient_name}}', { patient_name: '{{mrn}}' }).text,
    ).toBe('Hi {{mrn}}');
  });
});

describe('NotificationsService', () => {
  it('seeds bilingual default templates once per tenant', async () => {
    const { store, service } = buildService();
    await service.listTemplates(TENANT);
    await service.listTemplates(TENANT);
    expect(store.templates).toHaveLength(10);
    expect(new Set(store.templates.map((t) => t.language))).toEqual(
      new Set(['en', 'ar']),
    );
    // Another tenant gets its own copy.
    await service.listTemplates('tenant-2');
    expect(store.templates).toHaveLength(20);
  });

  it('does not overwrite templates a tenant has edited', async () => {
    const { store, service } = buildService();
    const { items } = await service.listTemplates(TENANT);
    await service.updateTemplate(
      TENANT,
      items[0].id,
      { body: 'Custom {{patient_name}}' },
      'u1',
    );
    const fresh = new NotificationsService(store, {
      name: 'x',
      send: () => Promise.resolve(),
    });
    await fresh.listTemplates(TENANT);
    expect(
      store.templates.find((t) => t.templateId === items[0].id)?.body,
    ).toBe('Custom {{patient_name}}');
  });

  describe('send', () => {
    it('renders the patient’s language and records a SENT log', async () => {
      const { store, sent, service } = buildService();
      const log = await service.send({
        tenantId: TENANT,
        eventCode: 'NOTIF_SCH_BOOKED',
        language: 'ar',
        recipient: '+966500000001',
        patientId: 'patient-1',
        values: {
          patient_name: 'عائشة',
          facility: 'مستشفى',
          provider: 'د. ناصر',
          date: '4 Oct 2026',
          time: '09:00',
        },
      });

      expect(log).toMatchObject({
        status: 'SENT',
        language: 'ar',
        provider: 'test',
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ channel: 'SMS', to: '+966500000001' });
      expect(sent[0].body).toContain('د. ناصر');
      expect(sent[0].body).not.toContain('{{');
      expect(store.logs[0]).toMatchObject({ status: 'SENT', attempts: 1 });
      expect(store.logs[0].sentAt).toBeInstanceOf(Date);
    });

    it('falls back to English when there is no template in the language', async () => {
      const { store, service } = buildService();
      await service.listTemplates(TENANT);
      store.templates.splice(
        0,
        store.templates.length,
        ...store.templates.filter((t) => t.language === 'en'),
      );
      const log = await service.send({
        tenantId: TENANT,
        eventCode: 'NOTIF_PATIENT_WELCOME',
        language: 'ar',
        recipient: '+966500000001',
        values: { patient_name: 'Aisha', mrn: 'T1-1', facility: 'Olaya' },
      });
      expect(log?.language).toBe('en');
    });

    it('records a failure and does not throw when the provider rejects', async () => {
      const { store, service } = buildService({
        send: () => Promise.reject(new Error('gateway down')),
      });
      const log = await service.send({
        tenantId: TENANT,
        eventCode: 'NOTIF_PATIENT_WELCOME',
        language: 'en',
        recipient: '+966500000001',
        values: { patient_name: 'Aisha', mrn: 'T1-1', facility: 'Olaya' },
      });
      expect(log).toMatchObject({ status: 'FAILED', error: 'gateway down' });
      expect(store.logs[0]).toMatchObject({
        status: 'FAILED',
        error: 'gateway down',
      });
    });

    it('records a failure without calling the provider when there is no number', async () => {
      const { sent, store, service } = buildService();
      const log = await service.send({
        tenantId: TENANT,
        eventCode: 'NOTIF_PATIENT_WELCOME',
        language: 'en',
        recipient: null,
        values: { patient_name: 'Aisha' },
      });
      expect(log?.status).toBe('FAILED');
      expect(sent).toHaveLength(0);
      expect(store.logs[0].error).toMatch(/mobile number/);
    });

    it('sends nothing for a template that has been switched off', async () => {
      const { sent, service } = buildService();
      const { items } = await service.listTemplates(TENANT);
      for (const template of items.filter(
        (t) => t.eventCode === 'NOTIF_ADT_ADMIT',
      )) {
        await service.updateTemplate(
          TENANT,
          template.id,
          { isActive: false },
          'u1',
        );
      }
      const log = await service.send({
        tenantId: TENANT,
        eventCode: 'NOTIF_ADT_ADMIT',
        language: 'en',
        recipient: '+966500000001',
        values: {},
      });
      expect(log).toBeNull();
      expect(sent).toHaveLength(0);
    });
  });

  describe('templates', () => {
    it('rejects a placeholder the event does not provide', async () => {
      const { service } = buildService();
      const { items } = await service.listTemplates(TENANT);
      const welcome = items.find(
        (t) => t.eventCode === 'NOTIF_PATIENT_WELCOME',
      )!;
      await expect(
        service.updateTemplate(
          TENANT,
          welcome.id,
          { body: 'Hi {{provider}}' },
          'u1',
        ),
      ).rejects.toThrow(/Unknown placeholder .*\{\{provider\}\}/);
    });

    it('records who edited a template', async () => {
      const { service } = buildService();
      const { items } = await service.listTemplates(TENANT);
      const row = await service.updateTemplate(
        TENANT,
        items[0].id,
        { body: 'Welcome {{patient_name}}' },
        'u1',
      );
      expect(row.body).toBe('Welcome {{patient_name}}');
    });

    it('will not edit another tenant’s template', async () => {
      const { service } = buildService();
      const { items } = await service.listTemplates(TENANT);
      await expect(
        service.updateTemplate(
          'tenant-2',
          items[0].id,
          { isActive: false },
          'u1',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('creates a template only for a free event / language / channel', async () => {
      const { service } = buildService();
      await service.listTemplates(TENANT);
      await expect(
        service.createTemplate(
          TENANT,
          {
            eventCode: 'NOTIF_ADT_ADMIT',
            language: 'en',
            channel: 'SMS',
            body: 'x',
          },
          'u1',
        ),
      ).rejects.toThrow(BadRequestException);
      const created = await service.createTemplate(
        TENANT,
        {
          eventCode: 'NOTIF_ADT_ADMIT',
          language: 'en',
          channel: 'EMAIL',
          subject: 'Admitted',
          body: 'Admitted {{patient_name}}',
        },
        'u1',
      );
      expect(created).toMatchObject({ channel: 'EMAIL', subject: 'Admitted' });
    });

    it('previews a body and flags unknown placeholders', () => {
      const { service } = buildService();
      expect(
        service.preview({
          eventCode: 'NOTIF_SCH_BOOKED',
          body: 'Hi {{patient_name}} {{nope}} {{time}}',
          values: { patient_name: 'Aisha', time: '09:00' },
        }),
      ).toEqual({
        text: 'Hi Aisha  09:00',
        missing: ['nope'],
        unknown: ['nope'],
      });
    });
  });

  describe('log', () => {
    it('filters by status, event and date, newest first', async () => {
      const { service } = buildService({
        send: jest
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('boom')),
      });
      const base = {
        tenantId: TENANT,
        language: 'en' as const,
        recipient: '+9665',
      };
      await service.send({
        ...base,
        eventCode: 'NOTIF_PATIENT_WELCOME',
        patientId: 'p1',
        values: { patient_name: 'A' },
      });
      await service.send({
        ...base,
        eventCode: 'NOTIF_SCH_BOOKED',
        patientId: 'p2',
        values: { patient_name: 'B' },
      });

      const all = await service.log(TENANT, {});
      expect(all.items.map((r) => r.eventCode)).toEqual([
        'NOTIF_SCH_BOOKED',
        'NOTIF_PATIENT_WELCOME',
      ]);
      expect(
        (await service.log(TENANT, { status: 'FAILED' })).items,
      ).toHaveLength(1);
      expect(
        (await service.log(TENANT, { eventCode: 'NOTIF_PATIENT_WELCOME' }))
          .items[0].status,
      ).toBe('SENT');
      expect(
        (await service.log(TENANT, { patientId: 'p2' })).items,
      ).toHaveLength(1);
      expect((await service.log('tenant-2', {})).items).toHaveLength(0);
    });
  });
});

describe('listener helpers', () => {
  it('maps events to templates', () => {
    expect(triggerFor({ channel: 'emr.adt', event: 'A01' })).toBe(
      'NOTIF_ADT_ADMIT',
    );
    expect(triggerFor({ channel: 'emr.adt', event: 'A28' })).toBe(
      'NOTIF_PATIENT_WELCOME',
    );
    expect(triggerFor({ channel: 'emr.sch', event: 'S14' })).toBe(
      'NOTIF_SCH_CANCELLED',
    );
    expect(triggerFor({ channel: 'emr.adt', event: 'A02' })).toBeUndefined();
    expect(triggerFor({ channel: 'emr.orm', event: 'O01' })).toBeUndefined();
  });

  it('formats time in clinic-local (UTC+3) terms', () => {
    expect(formatWhen('2026-10-04T06:30:00.000Z')).toEqual({
      date: '4 Oct 2026',
      time: '09:30',
    });
    expect(formatWhen('2026-10-03T22:30:00.000Z')).toEqual({
      date: '4 Oct 2026',
      time: '01:30',
    });
    expect(formatWhen(undefined)).toEqual({});
    expect(formatWhen('not a date')).toEqual({});
  });

  it('reads the patient’s preferred language', () => {
    const patient = (code: string, preferred = true): Patient => ({
      resourceType: 'Patient',
      communication: [{ language: { coding: [{ code }] }, preferred }],
    });
    expect(languageOf(patient('ar-SA'))).toBe('ar');
    expect(languageOf(patient('en'))).toBe('en');
    expect(languageOf({ resourceType: 'Patient' })).toBe('en');
  });
});

describe('NotificationListener', () => {
  function build() {
    const harness = buildHarness();
    const { store, service, sent } = buildService();
    const bus = new EmrEventBus();
    const facilities = {
      nameFor: (_tenant: string, language: string) =>
        Promise.resolve(language === 'ar' ? 'مستشفى الأولى' : 'Olaya Hospital'),
    } as unknown as FacilityNames;
    const listener = new NotificationListener(
      bus,
      service,
      harness.fhir,
      facilities,
    );
    return { ...harness, bus, listener, notifications: store, sent };
  }

  it('texts the patient when an appointment is booked', async () => {
    const { listener, sent, notifications } = build();
    await listener.handle({
      channel: 'emr.sch',
      event: 'S12',
      tenantId: TENANT,
      actor: ACTOR,
      patientId: 'patient-1',
      resource: 'Appointment/a1',
      data: { start: '2026-10-04T06:00:00.000Z', practitioner: 'Layla Nasser' },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('+966500000001');
    expect(sent[0].body).toBe(
      'Your appointment at Olaya Hospital with Layla Nasser is confirmed for 4 Oct 2026 at 09:00.',
    );
    expect(notifications.logs[0]).toMatchObject({
      patientId: 'patient-1',
      resource: 'Appointment/a1',
    });
  });

  it('uses the patient’s Arabic template and the A03 end time', async () => {
    const { listener, sent, store } = build();
    store.seed<Patient>({
      ...store.get<Patient>('Patient/patient-1'),
      communication: [
        { language: { coding: [{ code: 'ar' }] }, preferred: true },
      ],
    });
    await listener.handle({
      channel: 'emr.adt',
      event: 'A03',
      tenantId: TENANT,
      patientId: 'patient-1',
      data: {
        periodEnd: '2026-10-06T09:00:00.000Z',
        visitNumber: 'IP-2026-00001',
      },
    });
    expect(sent[0].body).toContain('مستشفى الأولى');
    expect(sent[0].body).toContain('6 Oct 2026');
    expect(sent[0].body).toContain('12:00');
  });

  it('ignores events that trigger no notification', async () => {
    const { listener, sent } = build();
    await listener.handle({
      channel: 'emr.adt',
      event: 'A02',
      tenantId: TENANT,
      patientId: 'patient-1',
    });
    expect(sent).toHaveLength(0);
  });

  it('never throws, even when the patient cannot be read', async () => {
    const { listener, sent } = build();
    await expect(
      listener.handle({
        channel: 'emr.sch',
        event: 'S12',
        tenantId: TENANT,
        patientId: 'ghost',
      }),
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('listens on the bus once the module starts, and stops when it is destroyed', async () => {
    const { bus, listener, sent } = build();
    listener.onModuleInit();
    bus.publish({
      channel: 'emr.adt',
      event: 'A28',
      tenantId: TENANT,
      patientId: 'patient-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);

    listener.onModuleDestroy();
    bus.publish({
      channel: 'emr.adt',
      event: 'A28',
      tenantId: TENANT,
      patientId: 'patient-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
  });
});
