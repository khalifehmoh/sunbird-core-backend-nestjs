import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCookieAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../auth/public.decorator';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { actorOf } from '../../fhir/medplum-actor';
import { MedplumRegistry } from '../../fhir/medplum-registry';
import type { AuthenticatedRequest } from '../common/request';
import { EMR_PERMISSIONS } from '../emr.constants';
import { integrationKeyMatches } from './integration-key';
import { MessagesQueryDto, SubmitMessageDto } from './integration.dto';
import { IntegrationService } from './integration.service';

@ApiTags('emr-integration')
@Controller('emr/integration')
@UseGuards(PermissionsGuard)
export class IntegrationController {
  constructor(
    private readonly integration: IntegrationService,
    private readonly config: ConfigService,
    private readonly registry: MedplumRegistry,
  ) {}

  /**
   * HL7 v2 over HTTP for external systems: the body is the raw message and the
   * response is the HL7 ACK. Callers authenticate with a shared key and name
   * their tenant, since they carry no user session.
   */
  @Public()
  @Post('inbound')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async inbound(
    @Headers('x-integration-key') key: string | undefined,
    @Headers('x-tenant-id') tenantId: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const expected = this.config.get<string>('integration.apiKey');
    if (!expected) {
      throw new ServiceUnavailableException(
        'Inbound integration is disabled. Set INTEGRATION_API_KEY.',
      );
    }
    if (!integrationKeyMatches(expected, key)) {
      throw new UnauthorizedException('Invalid integration key');
    }
    if (!tenantId || !this.registry.tenant(tenantId)) {
      throw new BadRequestException('Unknown or missing x-tenant-id');
    }
    if (typeof body !== 'string') {
      throw new BadRequestException(
        'Send the HL7 message as text/plain (or application/hl7-v2)',
      );
    }
    const outcome = await this.integration.ingest(tenantId, body, 'HL7');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Message-Id', outcome.messageId);
    return outcome.ack;
  }

  /** Submit a message by hand (testing, or replaying one from another system). */
  @Post('messages')
  @ApiCookieAuth('cookieAuth')
  @RequirePermissions(EMR_PERMISSIONS.integration.update)
  async submit(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SubmitMessageDto,
  ) {
    const { tenantId } = actorOf(req.user);
    const outcome = await this.integration.ingest(
      tenantId,
      dto.message,
      'MANUAL',
    );
    return {
      messageId: outcome.messageId,
      status: outcome.status,
      ackCode: outcome.ackCode,
      detail: outcome.detail,
      ack: outcome.ack,
    };
  }

  @Get('messages')
  @ApiCookieAuth('cookieAuth')
  @RequirePermissions(EMR_PERMISSIONS.integration.read)
  list(@Req() req: AuthenticatedRequest, @Query() query: MessagesQueryDto) {
    return this.integration.list(actorOf(req.user).tenantId, {
      status: query.status,
      messageType: query.messageType,
      q: query.q,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
    });
  }

  @Get('stats')
  @ApiCookieAuth('cookieAuth')
  @RequirePermissions(EMR_PERMISSIONS.integration.read)
  stats(@Req() req: AuthenticatedRequest) {
    return this.integration.stats(actorOf(req.user).tenantId);
  }

  @Get('messages/:id')
  @ApiCookieAuth('cookieAuth')
  @RequirePermissions(EMR_PERMISSIONS.integration.read)
  get(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.integration.get(actorOf(req.user).tenantId, id);
  }

  @Post('messages/:id/retry')
  @HttpCode(200)
  @ApiCookieAuth('cookieAuth')
  @RequirePermissions(EMR_PERMISSIONS.integration.update)
  async retry(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const actor = actorOf(req.user);
    const outcome = await this.integration.retry(
      actor.tenantId,
      id,
      actor.userId,
    );
    return {
      messageId: outcome.messageId,
      status: outcome.status,
      ackCode: outcome.ackCode,
      detail: outcome.detail,
    };
  }
}
