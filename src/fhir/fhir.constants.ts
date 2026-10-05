/**
 * FHIR gateway policy and coding systems.
 *
 * Spike scope: patient management. The allow-lists below are what makes this
 * service a real front door rather than an open proxy — a resource type that is
 * not listed here is simply not reachable through the API.
 */

/** Clinical resource types the gateway may read and write. */
export const WRITABLE_RESOURCE_TYPES = [
  'AllergyIntolerance',
  'Condition',
  'Communication',
  'Coverage',
  'DiagnosticReport',
  'Encounter',
  'Goal',
  'Immunization',
  'Location',
  'MedicationRequest',
  'MedicationStatement',
  'Observation',
  'Organization',
  'Patient',
  'Practitioner',
  'PractitionerRole',
  'QuestionnaireResponse',
  'RelatedPerson',
  'ServiceRequest',
  'Task',
] as const;

/**
 * Terminology and conformance resources the gateway may read but never write.
 * `@medplum/react` needs these to render forms and search results: it resolves
 * element definitions through `StructureDefinition` and expands bound value
 * sets through `ValueSet/$expand`.
 */
export const READONLY_RESOURCE_TYPES = [
  'CodeSystem',
  'Questionnaire',
  'SearchParameter',
  'StructureDefinition',
  'ValueSet',
] as const;

/** Non-resource paths the gateway forwards, e.g. `fhir/R4/$graphql`. */
export const ALLOWED_OPERATIONS = ['$graphql', 'metadata'] as const;

/**
 * Sunbird permission codes (`core.permissions.permission_code`) guarding the
 * clinical FHIR surface and ADT actions.
 */
export const PATIENT_MGMT_PERMISSIONS = {
  read: 'PATIENT_MGMT_READ',
  create: 'PATIENT_MGMT_CREATE',
  update: 'PATIENT_MGMT_UPDATE',
  delete: 'PATIENT_MGMT_DELETE',
} as const;

/** Identifier systems. NPHIES is the Saudi national FHIR R4 exchange. */
export const NATIONAL_ID_SYSTEM = 'http://nphies.sa/identifier/nationalid';
export const IQAMA_SYSTEM = 'http://nphies.sa/identifier/iqama';
export const MRN_SYSTEM = 'https://sunbird.health/fhir/mrn';
/** Links a FHIR `Organization` back to its Sunbird tenant code. */
export const ORG_TENANT_CODE_SYSTEM = 'https://sunbird.health/fhir/tenant-code';

/** Encounter visit number (PV1-19 style). */
export const VISIT_NUMBER_SYSTEM = 'https://sunbird.health/fhir/visit-number';
/** Location business identifiers (ward / room / bed codes). */
export const LOCATION_CODE_SYSTEM = 'https://sunbird.health/fhir/location-code';
/** Last ADT event applied to an Encounter (A01–A05). */
export const ADT_EVENT_SYSTEM = 'https://sunbird.health/fhir/adt-event';

/** HL7 terminology. */
export const IDENTIFIER_TYPE_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/v2-0203';
export const MARITAL_STATUS_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus';
export const LANGUAGE_EXTENSION_URL =
  'http://hl7.org/fhir/StructureDefinition/language';
export const ENCOUNTER_CLASS_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/v3-ActCode';
export const ADMIT_SOURCE_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/admit-source';
export const DISCHARGE_DISPOSITION_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/discharge-disposition';
export const PARTICIPANT_TYPE_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/v3-ParticipationType';
export const LOCATION_STATUS_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/v2-0116';
export const LOCATION_PHYSICAL_TYPE_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/location-physical-type';
export const ICD10_SYSTEM = 'http://hl7.org/fhir/sid/icd-10';

/** Which event path produced a notification Communication (bot | bullmq). */
export const EVENT_PATH_SYSTEM = 'https://sunbird.health/fhir/event-path';
/** Idempotency key for one discharge notification per encounter + path. */
export const EVENT_NOTIFICATION_SYSTEM =
  'https://sunbird.health/fhir/event-notification';

export const FHIR_JSON_CONTENT_TYPE = 'application/fhir+json';
