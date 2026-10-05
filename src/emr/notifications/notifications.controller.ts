import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
  CreateTemplateDto,
  NotificationLogQueryDto,
  PreviewTemplateDto,
  UpdateTemplateDto,
  type NotificationLogRow,
  type TemplateRow,
} from './notifications.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('emr-notifications')
@ApiCookieAuth('cookieAuth')
@Controller('emr/notifications')
@UseGuards(PermissionsGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  log(
    @Req() req: AuthenticatedRequest,
    @Query() query: NotificationLogQueryDto,
  ): Promise<{ items: NotificationLogRow[] }> {
    return this.notifications.log(actorOf(req.user).tenantId, query);
  }

  @Get('events')
  @RequirePermissions(EMR_PERMISSIONS.notificationAdmin)
  events() {
    return { items: this.notifications.events() };
  }

  @Get('templates')
  @RequirePermissions(EMR_PERMISSIONS.notificationAdmin)
  templates(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: TemplateRow[] }> {
    return this.notifications.listTemplates(actorOf(req.user).tenantId);
  }

  @Post('templates')
  @RequirePermissions(EMR_PERMISSIONS.notificationAdmin)
  createTemplate(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateTemplateDto,
  ): Promise<TemplateRow> {
    return this.notifications.createTemplate(
      actorOf(req.user).tenantId,
      body,
      req.user.userId,
    );
  }

  @Post('templates/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(EMR_PERMISSIONS.notificationAdmin)
  preview(@Body() body: PreviewTemplateDto) {
    return this.notifications.preview(body);
  }

  @Put('templates/:id')
  @RequirePermissions(EMR_PERMISSIONS.notificationAdmin)
  updateTemplate(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTemplateDto,
  ): Promise<TemplateRow> {
    return this.notifications.updateTemplate(
      actorOf(req.user).tenantId,
      id,
      body,
      req.user.userId,
    );
  }
}
