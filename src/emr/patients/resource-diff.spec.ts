import { diffResources } from './resource-diff';

describe('diffResources', () => {
  it('reports every field as added for the first version', () => {
    const changes = diffResources(undefined, {
      resourceType: 'Patient',
      id: 'p1',
      meta: { versionId: '1' },
      gender: 'female',
      telecom: [{ system: 'phone', value: '+966500000001' }],
    });

    expect(changes).toEqual([
      { path: 'gender', before: null, after: 'female' },
      { path: 'telecom[0].system', before: null, after: 'phone' },
      { path: 'telecom[0].value', before: null, after: '+966500000001' },
    ]);
  });

  it('reports changed, added and removed fields, and nothing else', () => {
    const before = {
      resourceType: 'Patient',
      meta: { versionId: '1' },
      gender: 'female',
      birthDate: '1990-05-01',
      telecom: [{ value: 'a' }, { value: 'b' }],
    };
    const after = {
      resourceType: 'Patient',
      meta: { versionId: '2', lastUpdated: 'x' },
      gender: 'female',
      birthDate: '1991-05-01',
      telecom: [{ value: 'a' }],
      active: true,
    };

    expect(diffResources(before, after)).toEqual([
      { path: 'active', before: null, after: 'true' },
      { path: 'birthDate', before: '1990-05-01', after: '1991-05-01' },
      { path: 'telecom[1].value', before: 'b', after: null },
    ]);
  });

  it('ignores server-maintained fields', () => {
    expect(
      diffResources(
        {
          resourceType: 'Patient',
          id: '1',
          meta: { versionId: '1' },
          text: { div: 'a' },
        },
        {
          resourceType: 'Patient',
          id: '1',
          meta: { versionId: '2' },
          text: { div: 'b' },
        },
      ),
    ).toEqual([]);
  });

  it('shortens very long values', () => {
    const [change] = diffResources(undefined, { note: 'x'.repeat(500) });

    expect(change.after).toHaveLength(201);
    expect(change.after?.endsWith('…')).toBe(true);
  });
});
