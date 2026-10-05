import type { Encounter, Patient } from '@medplum/fhirtypes';
import type { MedplumActor } from '../../fhir/medplum-actor';
import type { MedplumRegistry } from '../../fhir/medplum-registry';
import type { MedplumService } from '../../fhir/medplum.service';
import { FakeFhirStore } from '../../fhir/testing/fake-fhir-store';
import { FhirAccess } from '../common/fhir-access';
import { LANGUAGE_EXTENSION_URL, MRN_SYSTEM } from '../../fhir/fhir.constants';

export const ACTOR: MedplumActor = { tenantId: 'tenant-1', userId: 'user-1' };

/** A FHIR access layer backed by the in-memory store, for service specs. */
export function buildHarness() {
  const store = new FakeFhirStore();
  const medplum = {
    getClient: (actor: MedplumActor) => store.client(actor),
  } as unknown as MedplumService;
  const registry = {
    tenant: () => ({
      tenantCode: 'T1',
      members: { 'user-1': { membershipId: 'm-1', practitionerId: 'prac-1' } },
    }),
    organizationForMember: () => 'org-1',
  } as unknown as MedplumRegistry;
  const fhir = new FhirAccess(medplum, registry);

  store.seed({ resourceType: 'Practitioner', id: 'prac-1' });
  store.seed(patient('patient-1', 'T1-00001', 'Aisha Rahman', 'عائشة رحمن'));
  store.seed(patient('patient-2', 'T1-00002', 'Omar Said'));
  return { store, fhir, medplum, registry };
}

export function patient(
  id: string,
  mrn: string,
  name: string,
  nameAr?: string,
  mobile = '+966500000001',
): Patient {
  const [given, ...rest] = name.split(' ');
  return {
    resourceType: 'Patient',
    id,
    identifier: [{ system: MRN_SYSTEM, value: mrn }],
    name: [
      { use: 'official', given: [given], family: rest.join(' ') },
      ...(nameAr
        ? [
            {
              text: nameAr,
              extension: [{ url: LANGUAGE_EXTENSION_URL, valueCode: 'ar' }],
            },
          ]
        : []),
    ],
    gender: 'female',
    birthDate: '1990-05-01',
    telecom: [{ system: 'phone', value: mobile }],
  };
}

export function encounter(
  id: string,
  patientId: string,
  options: Partial<Encounter> = {},
): Encounter {
  return {
    resourceType: 'Encounter',
    id,
    status: 'in-progress',
    class: { code: 'IMP' },
    subject: { reference: `Patient/${patientId}` },
    period: { start: '2026-10-05T08:00:00.000Z' },
    ...options,
  };
}
