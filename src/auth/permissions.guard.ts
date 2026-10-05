import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { User } from '../database/entities/user.entity';
import { assertPermissions } from './permissions';
import { REQUIRED_PERMISSIONS_KEY } from './require-permissions.decorator';

/**
 * Applied per controller with `@UseGuards(PermissionsGuard)`, after the global
 * `JwtAuthGuard` has attached `request.user`. Routes without
 * `@RequirePermissions` are left to other checks.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: User }>();
    assertPermissions(request.user, ...required);
    return true;
  }
}
