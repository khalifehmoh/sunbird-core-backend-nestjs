import { ForbiddenException } from '@nestjs/common';
import { assertPermissions, hasPermissions } from './permissions';

describe('permissions', () => {
  it('requires every listed code', () => {
    const user = { role: 'STANDARD_USER', permissions: ['PATIENT_MGMT_READ'] };
    expect(hasPermissions(user, 'PATIENT_MGMT_READ')).toBe(true);
    expect(
      hasPermissions(user, 'PATIENT_MGMT_READ', 'PATIENT_MGMT_UPDATE'),
    ).toBe(false);
  });

  it('lets platform admins through, including comma-separated roles', () => {
    expect(
      hasPermissions({ role: 'CUSTOM,SUPER_ADMIN', permissions: [] }, 'X'),
    ).toBe(true);
    expect(hasPermissions({ role: 'ADMIN', permissions: [] }, 'X')).toBe(true);
  });

  it('does not treat TENANT_ADMIN as a bypass', () => {
    expect(hasPermissions({ role: 'TENANT_ADMIN', permissions: [] }, 'X')).toBe(
      false,
    );
  });

  it('denies a lab-only account the clinical codes', () => {
    const lab = {
      role: 'STANDARD_USER',
      permissions: ['LABORATORY_READ', 'SETTINGS_READ'],
    };
    expect(() => assertPermissions(lab, 'PATIENT_MGMT_READ')).toThrow(
      ForbiddenException,
    );
  });

  it('denies when there is no user', () => {
    expect(hasPermissions(undefined, 'X')).toBe(false);
  });
});
