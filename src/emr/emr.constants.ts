import { PATIENT_MGMT_PERMISSIONS } from '../fhir/fhir.constants';

/** Coding systems used by the EMR modules beyond the ones in `fhir.constants`. */
export const LOINC_SYSTEM = 'http://loinc.org';
export const UCUM_SYSTEM = 'http://unitsofmeasure.org';
export const SNOMED_SYSTEM = 'http://snomed.info/sct';
export const ICD10_AM_SYSTEM = 'http://hl7.org/fhir/sid/icd-10-am';
export const OBSERVATION_CATEGORY_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/observation-category';
export const INTERPRETATION_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation';
export const CONDITION_CATEGORY_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/condition-category';
export const CONDITION_CLINICAL_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/condition-clinical';
export const CONDITION_VERIFICATION_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/condition-ver-status';
export const APPOINTMENT_TYPE_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/v2-0276';
export const SERVICE_REQUEST_CATEGORY_SYSTEM = SNOMED_SYSTEM;

/** Where a record came from: MANUAL | HL7 | FHIR | DEVICE (blueprint `entry_source`). */
export const ENTRY_SOURCE_SYSTEM = 'https://sunbird.health/fhir/entry-source';
/** Last scheduling event applied to an Appointment (S12 book, S14 cancel). */
export const SCH_EVENT_SYSTEM = 'https://sunbird.health/fhir/sch-event';
/** Last order event applied to a ServiceRequest (O01 new, O01-CANCEL). */
export const ORM_EVENT_SYSTEM = 'https://sunbird.health/fhir/orm-event';
/** Flags a result Observation / DiagnosticReport that carries a critical value. */
export const RESULT_FLAG_SYSTEM = 'https://sunbird.health/fhir/result-flag';
export const RESULT_FLAG_CRITICAL = 'critical';
/** Placer order number (`ORD-2026-00001`) on a ServiceRequest. */
export const ORDER_NUMBER_SYSTEM = 'https://sunbird.health/fhir/order-number';
export const DIAGNOSIS_TYPE_SYSTEM =
  'https://sunbird.health/fhir/diagnosis-type';
/** Identifier on a DiagnosticReport that ties it to the HL7 message that made it. */
export const MESSAGE_CONTROL_SYSTEM =
  'https://sunbird.health/fhir/hl7-control-id';

/** `practitionerId@start`: one booking per provider and start time. */
export const APPOINTMENT_SLOT_SYSTEM =
  'https://sunbird.health/fhir/appointment-slot';
/** An external scheduler's appointment id (SCH-1), so SIU messages find it again. */
export const EXTERNAL_APPOINTMENT_SYSTEM =
  'https://sunbird.health/fhir/external-appointment';

export type EntrySource = 'MANUAL' | 'HL7' | 'FHIR' | 'DEVICE';
export const ENTRY_SOURCES: readonly EntrySource[] = [
  'MANUAL',
  'HL7',
  'FHIR',
  'DEVICE',
];

/**
 * Sunbird permission codes for the EMR surface.
 *
 * Clinical data lives behind the FHIR gateway, so the clinical modules reuse
 * `PATIENT_MGMT_*` (the same codes the gateway and ADT already check) and
 * scheduling uses the existing `APPOINTMENT_MGMT_*`. The blueprint's
 * `ORDER:*`, `VITALS:*`, `SCH:*`, `ADT:*` strings are design shorthand, not
 * rows in `core.permissions`. Integration and notification administration have
 * no live equivalent, so migration V003 seeds the blueprint's own `IT:*` and
 * `NOTIF:ADMIN` codes.
 */
export const EMR_PERMISSIONS = {
  clinical: PATIENT_MGMT_PERMISSIONS,
  scheduling: {
    read: 'APPOINTMENT_MGMT_READ',
    create: 'APPOINTMENT_MGMT_CREATE',
    update: 'APPOINTMENT_MGMT_UPDATE',
  },
  integration: {
    read: 'IT:READ',
    update: 'IT:UPDATE',
  },
  notificationAdmin: 'NOTIF:ADMIN',
} as const;

/**
 * Clinic hours and slot size. The blueprint specifies 30-minute slots; hours
 * and the weekend follow the Saudi working week (Sunday to Thursday) and are
 * the same for every provider until a per-provider schedule is modelled.
 */
export const SCHEDULING = {
  slotMinutes: 30,
  dayStartHour: 8,
  dayEndHour: 16,
  /** JS weekday numbers that are working days (0 = Sunday). */
  workingDays: [0, 1, 2, 3, 4],
  /** Asia/Riyadh has no DST, so a fixed offset is exact. */
  utcOffsetMinutes: 180,
} as const;
