import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { EMR_PERMISSIONS, SCHEDULING } from '../emr.constants';
import {
  AppointmentsQueryDto,
  BookAppointmentDto,
  CancelAppointmentDto,
  SlotsQueryDto,
  type AppointmentRow,
} from './appointments.dto';
import { AppointmentsService } from './appointments.service';
import type { DaySlots } from './scheduling';

@ApiTags('emr-appointments')
@ApiCookieAuth('cookieAuth')
@Controller('emr/appointments')
@UseGuards(PermissionsGuard)
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  /** Clinic hours and slot size, so the calendar can draw its axis. */
  @Get('clinic')
  @RequirePermissions(EMR_PERMISSIONS.scheduling.read)
  clinic() {
    return { ...SCHEDULING };
  }

  @Get('slots')
  @RequirePermissions(EMR_PERMISSIONS.scheduling.read)
  slots(
    @Req() req: AuthenticatedRequest,
    @Query() query: SlotsQueryDto,
  ): Promise<{ days: DaySlots[] }> {
    return this.appointments.slots(query, actorOf(req.user));
  }

  @Get()
  @RequirePermissions(EMR_PERMISSIONS.scheduling.read)
  list(
    @Req() req: AuthenticatedRequest,
    @Query() query: AppointmentsQueryDto,
  ): Promise<{ items: AppointmentRow[] }> {
    return this.appointments.list(query, actorOf(req.user));
  }

  /** S12: book. */
  @Post()
  @RequirePermissions(EMR_PERMISSIONS.scheduling.create)
  book(
    @Req() req: AuthenticatedRequest,
    @Body() body: BookAppointmentDto,
  ): Promise<AppointmentRow> {
    return this.appointments.book(body, actorOf(req.user));
  }

  /** S14: cancel. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(EMR_PERMISSIONS.scheduling.update)
  cancel(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelAppointmentDto,
  ): Promise<AppointmentRow> {
    return this.appointments.cancel(id, body.reason, actorOf(req.user));
  }

  @Post(':id/no-show')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(EMR_PERMISSIONS.scheduling.update)
  noShow(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AppointmentRow> {
    return this.appointments.noShow(id, actorOf(req.user));
  }
}
