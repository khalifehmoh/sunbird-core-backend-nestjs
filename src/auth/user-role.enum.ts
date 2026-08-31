export enum UserRole {
  ADMIN = 'ADMIN',
  USER = 'USER',
  MANAGER = 'MANAGER',
}

const PLATFORM_ADMIN_ROLES = new Set<string>([
  UserRole.ADMIN,
  'SUPER_ADMIN',
]);

export function roleCodes(role: string | null | undefined): string[] {
  return (role ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
}

export function isPlatformAdmin(role: string | null | undefined): boolean {
  return roleCodes(role).some((code) => PLATFORM_ADMIN_ROLES.has(code));
}

export function toApiRole(roleCode: string | null | undefined): UserRole {
  if (
    roleCode === UserRole.ADMIN ||
    roleCode === 'SUPER_ADMIN' ||
    roleCode === 'TENANT_ADMIN'
  ) {
    return UserRole.ADMIN;
  }
  if (roleCode === UserRole.MANAGER || roleCode === 'BRANCH_MANAGER') {
    return UserRole.MANAGER;
  }
  return UserRole.USER;
}

export function toDumpRoleCode(
  role: UserRole | undefined,
  hasTenant: boolean,
): string {
  if (role === UserRole.ADMIN) {
    return hasTenant ? 'TENANT_ADMIN' : 'SUPER_ADMIN';
  }
  if (role === UserRole.MANAGER) {
    return 'BRANCH_MANAGER';
  }
  return 'STANDARD_USER';
}
