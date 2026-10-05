import type { Bundle, Encounter, Location } from '@medplum/fhirtypes';
import {
  createEntry,
  isConcurrentModification,
  resultAt,
  updateEntry,
} from './fhir-transaction';

describe('fhir-transaction', () => {
  it('builds a POST entry with a placeholder id', () => {
    const entry = createEntry({
      resourceType: 'Encounter',
      status: 'planned',
    } as Encounter);

    expect(entry.request).toEqual({ method: 'POST', url: 'Encounter' });
    expect(entry.fullUrl).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });

  it('guards a PUT entry with the version that was read', () => {
    const bed: Location = {
      resourceType: 'Location',
      id: 'bed-1',
      meta: { versionId: '7' },
    };

    expect(updateEntry(bed).request).toEqual({
      method: 'PUT',
      url: 'Location/bed-1',
      ifMatch: 'W/"7"',
    });
  });

  it('leaves the PUT unguarded when the resource carries no version', () => {
    const request = updateEntry({
      resourceType: 'Location',
      id: 'bed-1',
    }).request;

    expect(request).toEqual({ method: 'PUT', url: 'Location/bed-1' });
  });

  it('refuses to update a resource that has no id', () => {
    expect(() => updateEntry({ resourceType: 'Location' })).toThrow(
      'without an id',
    );
  });

  it('reads the resource at an index of a transaction response', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction-response',
      entry: [{}, { resource: { resourceType: 'Location', id: 'bed-1' } }],
    };

    expect(resultAt<Location>(bundle, 1)?.id).toBe('bed-1');
    expect(resultAt(bundle, 0)).toBeUndefined();
    expect(resultAt(bundle, 5)).toBeUndefined();
  });

  it('recognises a changed or already-existing resource, not other failures', () => {
    const outcome = (id: string) => ({
      outcome: { id, resourceType: 'OperationOutcome', issue: [] },
    });

    expect(isConcurrentModification(outcome('precondition-failed'))).toBe(true);
    expect(isConcurrentModification(outcome('conflict'))).toBe(true);
    expect(isConcurrentModification(outcome('bad-request'))).toBe(false);
    expect(isConcurrentModification(new Error('network'))).toBe(false);
    expect(isConcurrentModification(null)).toBe(false);
  });
});
