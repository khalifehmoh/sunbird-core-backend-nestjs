import { buildCapabilityStatement } from './capability-statement';
import {
  READONLY_RESOURCE_TYPES,
  WRITABLE_RESOURCE_TYPES,
} from './fhir.constants';

const statement = buildCapabilityStatement({
  baseUrl: 'http://localhost/api/v1/fhir/R4',
  now: new Date('2026-10-06T09:00:00.000Z'),
});
const resources = statement.rest?.[0].resource ?? [];
const codes = (type: string) =>
  resources.find((r) => r.type === type)?.interaction?.map((i) => i.code);

describe('buildCapabilityStatement', () => {
  it('is an R4 server statement', () => {
    expect(statement).toMatchObject({
      resourceType: 'CapabilityStatement',
      fhirVersion: '4.0.1',
      kind: 'instance',
      status: 'active',
      date: '2026-10-06T09:00:00.000Z',
    });
    expect(statement.rest?.[0].mode).toBe('server');
    expect(statement.implementation?.url).toBe(
      'http://localhost/api/v1/fhir/R4',
    );
  });

  it('lists exactly the resource types the gateway exposes, once each', () => {
    const types = resources.map((r) => r.type);

    expect([...types].sort()).toEqual(
      [...WRITABLE_RESOURCE_TYPES, ...READONLY_RESOURCE_TYPES].sort(),
    );
    expect(new Set(types).size).toBe(types.length);
    expect(types).toContain('Appointment');
  });

  it('allows writes only on writable types', () => {
    expect(codes('Patient')).toEqual(
      expect.arrayContaining([
        'read',
        'search-type',
        'create',
        'update',
        'delete',
      ]),
    );
    expect(codes('ValueSet')).toEqual(
      expect.arrayContaining(['read', 'search-type']),
    );
    expect(codes('ValueSet')).not.toEqual(expect.arrayContaining(['create']));
    expect(codes('ValueSet')).not.toEqual(expect.arrayContaining(['update']));
  });

  it('does not advertise resource types that are not exposed', () => {
    expect(codes('AccessPolicy')).toBeUndefined();
    expect(codes('ProjectMembership')).toBeUndefined();
  });

  it('advertises $graphql', () => {
    expect(statement.rest?.[0].operation).toEqual([
      expect.objectContaining({ name: 'graphql' }),
    ]);
  });
});
