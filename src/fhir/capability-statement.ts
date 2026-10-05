import type { CapabilityStatement } from '@medplum/fhirtypes';
import {
  ALLOWED_OPERATIONS,
  READONLY_RESOURCE_TYPES,
  WRITABLE_RESOURCE_TYPES,
} from './fhir.constants';

type RestResource = NonNullable<
  NonNullable<CapabilityStatement['rest']>[number]['resource']
>[number];
type Interaction = NonNullable<RestResource['interaction']>[number]['code'];

const READ_INTERACTIONS: Interaction[] = [
  'read',
  'vread',
  'history-instance',
  'search-type',
];
const WRITE_INTERACTIONS: Interaction[] = ['create', 'update', 'delete'];

/**
 * The FHIR R4 CapabilityStatement for the gateway, generated from the same
 * allow-lists that decide what the gateway forwards, so the published surface
 * cannot drift from the real one. Medplum's own statement is deliberately not
 * proxied: it would advertise resource types this platform never exposes.
 */
export function buildCapabilityStatement(options: {
  baseUrl: string;
  now?: Date;
}): CapabilityStatement {
  const resource = (type: string, writable: boolean): RestResource => ({
    type: type as RestResource['type'],
    interaction: [
      ...READ_INTERACTIONS,
      ...(writable ? WRITE_INTERACTIONS : []),
    ].map((code) => ({ code })),
    versioning: 'versioned' as const,
    readHistory: true,
    updateCreate: false,
    conditionalCreate: writable,
    conditionalUpdate: writable,
    searchInclude: ['*'],
    searchRevInclude: ['*'],
  });

  return {
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: (options.now ?? new Date()).toISOString(),
    publisher: 'Sunbird',
    kind: 'instance',
    software: { name: 'Sunbird Core X FHIR gateway' },
    implementation: {
      description:
        'Tenant- and branch-scoped FHIR R4 access to Sunbird clinical data',
      url: options.baseUrl,
    },
    fhirVersion: '4.0.1',
    format: ['json', 'application/fhir+json'],
    rest: [
      {
        mode: 'server',
        documentation:
          "Requests are authorised with the Sunbird session cookie and executed with the caller's own access policy, so results are limited to their tenant and branch.",
        security: {
          cors: true,
          description:
            'Cookie-based session (access_token). Sunbird permission codes PATIENT_MGMT_READ / CREATE / UPDATE / DELETE guard each interaction.',
        },
        resource: [
          ...WRITABLE_RESOURCE_TYPES.map((type) => resource(type, true)),
          ...READONLY_RESOURCE_TYPES.map((type) => resource(type, false)),
        ].sort((a, b) => a.type.localeCompare(b.type)),
        operation: ALLOWED_OPERATIONS.filter((name) =>
          name.startsWith('$'),
        ).map((name) => ({
          name: name.slice(1),
          definition: `http://hl7.org/fhir/OperationDefinition/${name.slice(1)}`,
        })),
      },
    ],
  };
}
