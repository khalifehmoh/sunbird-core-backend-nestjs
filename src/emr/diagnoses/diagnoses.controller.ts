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
  CreateDiagnosisDto,
  DiagnosesQueryDto,
  type DiagnosisRow,
} from './diagnoses.dto';
import { DiagnosesService } from './diagnoses.service';

@ApiTags('emr-diagnoses')
@ApiCookieAuth('cookieAuth')
@Controller('emr/diagnoses')
@UseGuards(PermissionsGuard)
export class DiagnosesController {
  constructor(private readonly diagnoses: DiagnosesService) {}

  @Get()
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  list(
    @Req() req: AuthenticatedRequest,
    @Query() query: DiagnosesQueryDto,
  ): Promise<{ items: DiagnosisRow[] }> {
    return this.diagnoses.list(query, actorOf(req.user));
  }

  @Post()
  @RequirePermissions(EMR_PERMISSIONS.clinical.create)
  create(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateDiagnosisDto,
  ): Promise<DiagnosisRow> {
    return this.diagnoses.create(body, actorOf(req.user));
  }
}
