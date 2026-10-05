import { collectReferences } from './references';

describe('collectReferences', () => {
  it('finds nested and repeated references once each', () => {
    const result = collectReferences({
      resourceType: 'Encounter',
      subject: { reference: 'Patient/abc' },
      participant: [
        { individual: { reference: 'Practitioner/p-1' } },
        { individual: { reference: 'Practitioner/p-1' } },
      ],
      location: [{ location: { reference: 'Location/l.2', display: 'Bed' } }],
    });
    expect(result.local.sort()).toEqual([
      'Location/l.2',
      'Patient/abc',
      'Practitioner/p-1',
    ]);
    expect(result.unverifiable).toEqual([]);
  });

  it('skips contained and bundle placeholder references', () => {
    const result = collectReferences({
      contained: [{ id: 'x' }],
      subject: { reference: '#x' },
      managingOrganization: { reference: 'urn:uuid:7b3f' },
    });
    expect(result).toEqual({ local: [], unverifiable: [] });
  });

  it('flags references it cannot verify instead of ignoring them', () => {
    const result = collectReferences({
      subject: { reference: 'https://other.example/fhir/Patient/1' },
      partOf: { reference: 'Patient/1/_history/2' },
    });
    expect(result.local).toEqual([]);
    expect(result.unverifiable).toHaveLength(2);
  });

  it('ignores a `reference` that is not a string', () => {
    expect(
      collectReferences({ reference: { reference: 'Patient/1' } }).local,
    ).toEqual(['Patient/1']);
    expect(collectReferences(null)).toEqual({ local: [], unverifiable: [] });
  });
});
