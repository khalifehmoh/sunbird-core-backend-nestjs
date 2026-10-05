import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { actorOf } from '../../fhir/medplum-actor';
import type { AuthenticatedRequest } from '../common/request';
import { EMR_PERMISSIONS } from '../emr.constants';
import {
  RecordVitalsDto,
  VitalsQueryDto,
  type VitalsResponse,
} from './vitals.dto';
import { VITALS } from './vitals.rules';
import { VitalsService } from './vitals.service';

@ApiTags('emr-vitals')
@ApiCookieAuth('cookieAuth')
@Controller('emr/vitals')
@UseGuards(PermissionsGuard)
export class VitalsController {
  constructor(private readonly vitals: VitalsService) {}

  /** The vital signs the entry form offers, with their reference ranges. */
  @Get('definitions')
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  definitions() {
    return VITALS.map(
      ({
        key,
        loinc,
        display,
        displayAr,
        unit,
        normal,
        critical,
        plausible,
      }) => ({
        key,
        loinc,
        display,
        displayAr,
        unit,
        normal: normal ?? null,
        critical: critical ?? null,
        plausible,
      }),
    );
  }

  @Get()
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  list(
    @Req() req: AuthenticatedRequest,
    @Query() query: VitalsQueryDto,
  ): Promise<VitalsResponse> {
    return this.vitals.list(query, actorOf(req.user));
  }

  @Post()
  @RequirePermissions(EMR_PERMISSIONS.clinical.create)
  record(
    @Req() req: AuthenticatedRequest,
    @Body() body: RecordVitalsDto,
  ): Promise<VitalsResponse> {
    return this.vitals.record(body, actorOf(req.user));
  }
}
