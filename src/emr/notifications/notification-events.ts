import type { NotificationLanguage } from '../emr.entities';

export type NotificationEventDefinition = {
  code: string;
  label: string;
  /** `{{placeholders}}` a template for this event may use. */
  placeholders: readonly string[];
};

export const NOTIFICATION_EVENTS: readonly NotificationEventDefinition[] = [
  {
    code: 'NOTIF_PATIENT_WELCOME',
    label: 'Patient registered (welcome)',
    placeholders: ['patient_name', 'mrn', 'facility'],
  },
  {
    code: 'NOTIF_ADT_ADMIT',
    label: 'Inpatient admitted (A01)',
    placeholders: [
      'patient_name',
      'mrn',
      'facility',
      'visit_number',
      'ward',
      'date',
      'time',
    ],
  },
  {
    code: 'NOTIF_ADT_DISCHARGE',
    label: 'Inpatient discharged (A03)',
    placeholders: [
      'patient_name',
      'mrn',
      'facility',
      'visit_number',
      'date',
      'time',
    ],
  },
  {
    code: 'NOTIF_SCH_BOOKED',
    label: 'Appointment booked (S12)',
    placeholders: [
      'patient_name',
      'facility',
      'provider',
      'date',
      'time',
      'reason',
    ],
  },
  {
    code: 'NOTIF_SCH_CANCELLED',
    label: 'Appointment cancelled (S14)',
    placeholders: [
      'patient_name',
      'facility',
      'provider',
      'date',
      'time',
      'reason',
    ],
  },
];

export function eventDefinition(
  code: string,
): NotificationEventDefinition | undefined {
  return NOTIFICATION_EVENTS.find((event) => event.code === code);
}

type DefaultTemplate = {
  eventCode: string;
  language: NotificationLanguage;
  body: string;
};

/** Seeded for every tenant the first time its templates are read or used. */
export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  {
    eventCode: 'NOTIF_PATIENT_WELCOME',
    language: 'en',
    body: 'Welcome to {{facility}}, {{patient_name}}. Your medical record number is {{mrn}}.',
  },
  {
    eventCode: 'NOTIF_PATIENT_WELCOME',
    language: 'ar',
    body: 'مرحباً بك في {{facility}} يا {{patient_name}}. رقم ملفك الطبي هو {{mrn}}.',
  },
  {
    eventCode: 'NOTIF_ADT_ADMIT',
    language: 'en',
    body: '{{patient_name}} was admitted to {{facility}} on {{date}} at {{time}} ({{ward}}). Visit {{visit_number}}.',
  },
  {
    eventCode: 'NOTIF_ADT_ADMIT',
    language: 'ar',
    body: 'تم تنويم {{patient_name}} في {{facility}} بتاريخ {{date}} الساعة {{time}} ({{ward}}). رقم الزيارة {{visit_number}}.',
  },
  {
    eventCode: 'NOTIF_ADT_DISCHARGE',
    language: 'en',
    body: '{{patient_name}} was discharged from {{facility}} on {{date}} at {{time}}. Visit {{visit_number}}.',
  },
  {
    eventCode: 'NOTIF_ADT_DISCHARGE',
    language: 'ar',
    body: 'تم خروج {{patient_name}} من {{facility}} بتاريخ {{date}} الساعة {{time}}. رقم الزيارة {{visit_number}}.',
  },
  {
    eventCode: 'NOTIF_SCH_BOOKED',
    language: 'en',
    body: 'Your appointment at {{facility}} with {{provider}} is confirmed for {{date}} at {{time}}.',
  },
  {
    eventCode: 'NOTIF_SCH_BOOKED',
    language: 'ar',
    body: 'تم تأكيد موعدك في {{facility}} مع {{provider}} بتاريخ {{date}} الساعة {{time}}.',
  },
  {
    eventCode: 'NOTIF_SCH_CANCELLED',
    language: 'en',
    body: 'Your appointment at {{facility}} with {{provider}} on {{date}} at {{time}} was cancelled. Reason: {{reason}}.',
  },
  {
    eventCode: 'NOTIF_SCH_CANCELLED',
    language: 'ar',
    body: 'تم إلغاء موعدك في {{facility}} مع {{provider}} بتاريخ {{date}} الساعة {{time}}. السبب: {{reason}}.',
  },
];
