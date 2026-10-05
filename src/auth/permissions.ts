import { ForbiddenException } from '@nestjs/common';
import type { User } from '../database/entities/user.entity';
import { isPlatformAdmin } from './user-role.enum';

/**
 * Whether the caller holds every listed `core.permissions.permission_code`.
 * Platform admins (`SUPER_ADMIN`, `ADMIN`) bypass; `TENANT_ADMIN` does not.
 */
export function hasPermissions(
  user: Pick<User, 'role' | 'permissions'> | undefined,
  ...codes: string[]
): boolean {
  if (!user) return false;
  if (isPlatformAdmin(user.role)) return true;
  const held = new Set(user.permissions ?? []);
  return codes.every((code) => held.has(code));
}

export function assertPermissions(
  user: Pick<User, 'role' | 'permissions'> | undefined,
  ...codes: string[]
): void {
  if (!hasPermissions(user, ...codes)) {
    throw new ForbiddenException(`Missing permission: ${codes.join(', ')}`);
  }
}
