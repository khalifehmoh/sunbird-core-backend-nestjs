import { ForbiddenException } from '@nestjs/common';
import type { User } from '../database/entities/user.entity';
import { SYSTEM_MEMBER_ID } from './medplum-registry';

/**
 * Who a Medplum call is made for: a Sunbird user inside their tenant, or the
 * tenant's `system` automation identity. Every call carries one, because
 * Medplum treats a request without a delegated identity as the service client
 * itself, which is a Project Admin.
 */
export type MedplumActor = {
  tenantId: string;
  /** Sunbird `users.user_id`, or {@link SYSTEM_MEMBER_ID}. */
  userId: string;
};

export function actorOf(user: User | undefined): MedplumActor {
  const tenantId = user?.tenant?.tenantId;
  if (!user || !tenantId) {
    throw new ForbiddenException('User is not associated with a tenant');
  }
  return { tenantId, userId: user.userId };
}

export function systemActor(tenantId: string): MedplumActor {
  return { tenantId, userId: SYSTEM_MEMBER_ID };
}
