import type { Patient } from '@medplum/fhirtypes';
import { TENANT_TAG_SYSTEM } from './fhir.constants';
import {
  applyTenantTag,
  belongsToTenant,
  readTenantTag,
  scopeSearchParams,
} from './tenant-scope';

const TENANT_A = 'a0abd516-c1d0-492b-8bfd-30e60166e749';
const TENANT_B = '3183fb3e-68ed-4427-8061-aa2aa14898a2';

describe('tenant-scope', () => {
  describe('applyTenantTag', () => {
    it('tags a resource that has no meta', () => {
      const tagged = applyTenantTag<Patient>(
        { resourceType: 'Patient' },
        TENANT_A,
      );
      expect(readTenantTag(tagged)).toBe(TENANT_A);
    });

    it('preserves unrelated meta and tags', () => {
      const tagged = applyTenantTag<Patient>(
        {
          resourceType: 'Patient',
          meta: {
            versionId: 'v1',
            tag: [{ system: 'https://example.org/other', code: 'keep' }],
          },
        },
        TENANT_A,
      );

      expect(tagged.meta?.versionId).toBe('v1');
      expect(tagged.meta?.tag).toEqual([
        { system: 'https://example.org/other', code: 'keep' },
        { system: TENANT_TAG_SYSTEM, code: TENANT_A },
      ]);
    });

    it('replaces a tenant tag rather than appending a second one', () => {
      const tagged = applyTenantTag<Patient>(
        {
          resourceType: 'Patient',
          meta: { tag: [{ system: TENANT_TAG_SYSTEM, code: TENANT_B }] },
        },
        TENANT_A,
      );

      expect(tagged.meta?.tag).toEqual([
        { system: TENANT_TAG_SYSTEM, code: TENANT_A },
      ]);
    });

    it('does not mutate the input resource', () => {
      const original: Patient = { resourceType: 'Patient' };
      applyTenantTag(original, TENANT_A);
      expect(original.meta).toBeUndefined();
    });
  });

  describe('belongsToTenant', () => {
    it('rejects an untagged resource', () => {
      expect(belongsToTenant({ resourceType: 'Patient' }, TENANT_A)).toBe(
        false,
      );
    });

    it('rejects a resource tagged for another tenant', () => {
      const patient = applyTenantTag<Patient>(
        { resourceType: 'Patient' },
        TENANT_B,
      );
      expect(belongsToTenant(patient, TENANT_A)).toBe(false);
    });

    it('accepts a resource tagged for this tenant', () => {
      const patient = applyTenantTag<Patient>(
        { resourceType: 'Patient' },
        TENANT_A,
      );
      expect(belongsToTenant(patient, TENANT_A)).toBe(true);
    });
  });

  describe('scopeSearchParams', () => {
    it('adds the tenant filter to an empty query', () => {
      const scoped = scopeSearchParams(new URLSearchParams(''), TENANT_A);
      expect(scoped.get('_tag')).toBe(`${TENANT_TAG_SYSTEM}|${TENANT_A}`);
    });

    it('keeps caller parameters, including repeated ones', () => {
      const scoped = scopeSearchParams(
        new URLSearchParams('name=ali&_count=5&_include=a&_include=b'),
        TENANT_A,
      );

      expect(scoped.get('name')).toBe('ali');
      expect(scoped.get('_count')).toBe('5');
      expect(scoped.getAll('_include')).toEqual(['a', 'b']);
    });

    it('drops a caller-supplied _tag so scope cannot be widened', () => {
      const scoped = scopeSearchParams(
        new URLSearchParams(`_tag=${TENANT_TAG_SYSTEM}|${TENANT_B}&name=ali`),
        TENANT_A,
      );

      expect(scoped.getAll('_tag')).toEqual([
        `${TENANT_TAG_SYSTEM}|${TENANT_A}`,
      ]);
      expect(scoped.get('name')).toBe('ali');
    });
  });
});
