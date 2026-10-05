import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { actorOf } from '../../fhir/medplum-actor';
import type { AuthenticatedRequest } from '../common/request';
import { EMR_PERMISSIONS } from '../emr.constants';
import { DashboardService } from './dashboard.service';

@ApiTags('emr-dashboard')
@ApiCookieAuth('cookieAuth')
@Controller('emr/dashboard')
@UseGuards(PermissionsGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** Page 1: eight KPI cards, the seven-day activity chart, critical alerts. */
  @Get('summary')
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  summary(@Req() req: AuthenticatedRequest) {
    return this.dashboard.summary(actorOf(req.user));
  }

  /** Page 25 */
  @Get('registration')
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  registration(@Req() req: AuthenticatedRequest) {
    return this.dashboard.registration(actorOf(req.user));
  }

  /** Page 26 */
  @Get('clinical')
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  clinical(@Req() req: AuthenticatedRequest) {
    return this.dashboard.clinical(actorOf(req.user));
  }

  /** Page 27: IT administrators only. */
  @Get('integration')
  @RequirePermissions(EMR_PERMISSIONS.integration.read)
  integration(@Req() req: AuthenticatedRequest) {
    return this.dashboard.integrationStats(actorOf(req.user));
  }
}
