import { isPlatformAdmin, roleCodes } from './user-role.enum';

describe('roleCodes', () => {
  it('splits comma-separated role strings', () => {
    expect(roleCodes('CUSTOM222,SUPER_ADMIN')).toEqual([
      'CUSTOM222',
      'SUPER_ADMIN',
    ]);
  });

  it('returns an empty list for nullish values', () => {
    expect(roleCodes(null)).toEqual([]);
    expect(roleCodes(undefined)).toEqual([]);
    expect(roleCodes('')).toEqual([]);
  });
});

describe('isPlatformAdmin', () => {
  it('treats SUPER_ADMIN and ADMIN as platform admins', () => {
    expect(isPlatformAdmin('SUPER_ADMIN')).toBe(true);
    expect(isPlatformAdmin('ADMIN')).toBe(true);
  });

  it('detects SUPER_ADMIN among comma-separated codes', () => {
    expect(isPlatformAdmin('CUSTOM222,SUPER_ADMIN')).toBe(true);
  });

  it('does not treat TENANT_ADMIN as a platform admin', () => {
    expect(isPlatformAdmin('TENANT_ADMIN')).toBe(false);
    expect(isPlatformAdmin('USER')).toBe(false);
  });
});
