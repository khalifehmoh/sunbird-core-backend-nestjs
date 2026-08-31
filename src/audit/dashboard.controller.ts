import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { isPlatformAdmin } from '../auth/user-role.enum';
import { User } from '../database/entities/user.entity';
import { DashboardService } from './dashboard.service';
import { DashboardStatsDto } from './dto/dashboard.dto';

type AuthenticatedRequest = Request & { user: User };

@ApiTags('dashboard')
@ApiCookieAuth('cookieAuth')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @ApiOkResponse({ type: DashboardStatsDto })
  stats(@Req() req: AuthenticatedRequest): Promise<DashboardStatsDto> {
    return this.dashboardService.stats(this.tenantScope(req.user));
  }

  private tenantScope(user: User): string | undefined {
    if (isPlatformAdmin(user.role)) return undefined;
    if (!user.tenant?.tenantId) {
      throw new ForbiddenException('Tenant access is required');
    }
    return user.tenant.tenantId;
  }
}
