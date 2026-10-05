import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { RegisterPatientDto, WorklistQueryDto } from './patients.dto';
import { PatientsService } from './patients.service';

@ApiTags('emr-patients')
@ApiCookieAuth('cookieAuth')
@Controller('emr/patients')
@UseGuards(PermissionsGuard)
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @Get()
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  list(@Req() req: AuthenticatedRequest, @Query() query: WorklistQueryDto) {
    return this.patients.list(query, actorOf(req.user));
  }

  @Post()
  @RequirePermissions(EMR_PERMISSIONS.clinical.create)
  register(@Req() req: AuthenticatedRequest, @Body() dto: RegisterPatientDto) {
    return this.patients.register(dto, actorOf(req.user));
  }

  @Get(':id/overview')
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  overview(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.patients.overview(id, actorOf(req.user));
  }

  @Get(':id/audit')
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  audit(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.patients.audit(id, actorOf(req.user));
  }
}
