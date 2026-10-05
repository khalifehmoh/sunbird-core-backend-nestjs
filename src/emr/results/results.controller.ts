import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
  CriticalQueryDto,
  ResultsQueryDto,
  type CriticalAlert,
  type ResultDetail,
  type ResultRow,
} from './results.dto';
import { ResultsService } from './results.service';

@ApiTags('emr-results')
@ApiCookieAuth('cookieAuth')
@Controller('emr/results')
@UseGuards(PermissionsGuard)
export class ResultsController {
  constructor(private readonly results: ResultsService) {}

  @Get()
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  list(
    @Req() req: AuthenticatedRequest,
    @Query() query: ResultsQueryDto,
  ): Promise<{ items: ResultRow[]; criticalCount: number }> {
    return this.results.list(query, actorOf(req.user));
  }

  @Get('critical')
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  critical(
    @Req() req: AuthenticatedRequest,
    @Query() query: CriticalQueryDto,
  ): Promise<{ items: CriticalAlert[] }> {
    return this.results.critical(query, actorOf(req.user));
  }

  @Get(':id')
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  get(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResultDetail> {
    return this.results.get(id, actorOf(req.user));
  }
}
