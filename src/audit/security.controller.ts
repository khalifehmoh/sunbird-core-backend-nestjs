import { Controller, ForbiddenException, Get, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { isPlatformAdmin } from '../auth/user-role.enum';
import { User } from '../database/entities/user.entity';
import { AuditService } from './audit.service';
import { FailedLoginSummaryDto } from './dto/audit.dto';

type AuthenticatedRequest = Request & { user: User };

@ApiTags('security')
@ApiCookieAuth('cookieAuth')
@Controller('security')
export class SecurityController {
  constructor(private readonly auditService: AuditService) {}

  @Get('failed-login-summary')
  @ApiOkResponse({ type: FailedLoginSummaryDto })
  summary(
    @Req() req: AuthenticatedRequest,
    @Query() query: { from?: string; to?: string },
  ): Promise<FailedLoginSummaryDto> {
    return this.auditService.failedLoginSummary(this.tenantScope(req.user), query);
  }

  private tenantScope(user: User): string | undefined {
    if (isPlatformAdmin(user.role)) return undefined;
    if (!user.tenant?.tenantId) {
      throw new ForbiddenException('Tenant access is required');
    }
    return user.tenant.tenantId;
  }
}
