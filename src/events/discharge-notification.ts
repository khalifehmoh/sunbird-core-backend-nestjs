import type { Communication, Encounter, Patient } from '@medplum/fhirtypes';
import {
  EVENT_NOTIFICATION_SYSTEM,
  EVENT_PATH_SYSTEM,
} from '../fhir/fhir.constants';

export type EventPath = 'bot' | 'bullmq';

export const CLINICAL_EVENTS_QUEUE = 'clinical-events';

/** Marker embedded in Communication.payload for the demo SMS sink. */
export const DEMO_SMS_PAYLOAD_PREFIX = 'sunbird-demo-sms:';

export type DischargeNotificationJob = {
  encounterId: string;
  patientRef?: string;
  visitDisplay?: string;
  tenantId: string;
};

export type DemoSms = {
  provider: 'demo';
  to: string;
  body: string;
  sentAt: string;
};

const DEMO_FALLBACK_PHONE = '+966500000000';

/**
 * Resolve a display phone for the demo sink — Patient.telecom or a fixed
 * placeholder so the UI always has something to show without a paid gateway.
 */
export function resolveDemoSmsPhone(patient?: Patient): string {
  const fromPatient = patient?.telecom?.find(
    (t) => t.system === 'phone' && t.value?.trim(),
  )?.value;
  return fromPatient?.trim() || DEMO_FALLBACK_PHONE;
}

export function buildDemoSms(encounter: Encounter, phone: string): DemoSms {
  const visit =
    encounter.identifier?.find((id) => id.system?.includes('visit-number'))
      ?.value ??
    encounter.id ??
    'unknown';
  return {
    provider: 'demo',
    to: phone,
    body: `Sunbird demo: visit ${visit} discharged. No SMS provider charged.`,
    sentAt: new Date().toISOString(),
  };
}

export function parseDemoSms(
  communication: Communication,
): DemoSms | undefined {
  for (const part of communication.payload ?? []) {
    const text = part.contentString;
    if (!text?.startsWith(DEMO_SMS_PAYLOAD_PREFIX)) continue;
    try {
      return JSON.parse(text.slice(DEMO_SMS_PAYLOAD_PREFIX.length)) as DemoSms;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Same clinical side-effect for both event paths: a FHIR Communication that
 * stands in for NOTIF_ADT_DISCHARGE. The `event-path` identifier tells you
 * whether the Medplum Bot or the BullMQ worker wrote it.
 *
 * BullMQ may attach a demo SMS envelope in payload (no real gateway).
 */
export function buildDischargeCommunication(
  encounter: Encounter,
  path: EventPath,
  demoSms?: DemoSms,
): Communication {
  const encounterId = encounter.id ?? 'unknown';
  const patientRef = encounter.subject?.reference;
  const visit =
    encounter.identifier?.find((id) => id.system?.includes('visit-number'))
      ?.value ?? encounterId;

  const payload: Communication['payload'] = demoSms
    ? [
        { contentString: demoSms.body },
        {
          contentString: `${DEMO_SMS_PAYLOAD_PREFIX}${JSON.stringify(demoSms)}`,
        },
      ]
    : [
        {
          contentString: `[${path}] Discharge notification for visit ${visit}. Stand-in for NOTIF_ADT_DISCHARGE.`,
        },
      ];

  return {
    resourceType: 'Communication',
    identifier: [
      {
        system: EVENT_NOTIFICATION_SYSTEM,
        value: `discharge-${encounterId}-${path}`,
      },
      { system: EVENT_PATH_SYSTEM, value: path },
    ],
    status: 'completed',
    category: [
      {
        coding: [
          {
            system:
              'http://terminology.hl7.org/CodeSystem/communication-category',
            code: 'notification',
            display: 'Notification',
          },
        ],
        text: demoSms
          ? 'ADT discharge notification (demo SMS)'
          : 'ADT discharge notification',
      },
    ],
    medium: demoSms
      ? [
          {
            coding: [
              {
                system:
                  'http://terminology.hl7.org/CodeSystem/v3-ParticipationMode',
                code: 'SMSWRIT',
                display: 'SMS Message',
              },
            ],
            text: 'SMS (demo)',
          },
        ]
      : undefined,
    subject: patientRef ? { reference: patientRef } : undefined,
    about: [{ reference: `Encounter/${encounterId}` }],
    sent: demoSms?.sentAt ?? new Date().toISOString(),
    payload,
    meta: encounter.meta?.tag
      ? { tag: encounter.meta.tag.filter((t) => t.system?.includes('tenant')) }
      : undefined,
  };
}
