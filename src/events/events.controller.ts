import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  MessageEvent,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  Sse,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Encounter } from '@medplum/fhirtypes';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { Public } from '../auth/public.decorator';
import { User } from '../database/entities/user.entity';
import { actorOf } from '../fhir/medplum-actor';
import { MedplumRegistry } from '../fhir/medplum-registry';
import { EventsService } from './events.service';

type AuthenticatedRequest = Request & { user: User };

/**
 * FHIR Subscription rest-hook target (BullMQ path) + a small read API to
 * compare Bot vs BullMQ outcomes after a discharge.
 */
@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly config: ConfigService,
    private readonly registry: MedplumRegistry,
  ) {}

  /**
   * Called by Medplum when an Encounter matches the BullMQ subscription.
   * Auth is a shared secret header — Medplum has no Sunbird session cookie.
   */
  @Public()
  @Post('fhir-subscription')
  @ApiExcludeEndpoint()
  async fhirSubscription(
    @Headers('x-sunbird-subscription-secret') secret: string | undefined,
    @Query('tenantId') tenantId: string | undefined,
    @Body() body: Encounter | { resourceType?: string },
  ): Promise<{ accepted: boolean; jobId?: string }> {
    this.assertEnabled();
    const expected = this.config.getOrThrow<string>(
      'events.subscriptionSecret',
    );
    if (!secret || secret !== expected) {
      throw new UnauthorizedException('Invalid subscription secret');
    }

    if (body?.resourceType !== 'Encounter') {
      return { accepted: false };
    }

    if (!tenantId || !this.registry.tenant(tenantId)) {
      throw new BadRequestException('Unknown tenantId');
    }

    const result = await this.events.enqueueFromEncounter(
      body as Encounter,
      tenantId,
    );
    return { accepted: true, jobId: result.jobId };
  }

  @Get('notifications/:encounterId')
  @ApiCookieAuth('cookieAuth')
  @ApiOkResponse({
    description: 'Communications written by the bot and/or BullMQ paths.',
  })
  async notifications(
    @Req() req: AuthenticatedRequest,
    @Param('encounterId') encounterId: string,
  ) {
    this.assertEnabled();
    const actor = actorOf(req.user);
    const communications = await this.events.listNotifications(
      encounterId,
      actor,
    );
    return {
      encounterId,
      ...this.events.summarizePaths(communications),
      communications,
    };
  }

  /**
   * SSE watch (server owns timeout + demo stagger). Emits an initial empty
   * snapshot, then updates as Bot/BullMQ Communications appear, then
   * complete|timeout.
   */
  @Sse('notifications/:encounterId/stream')
  @ApiCookieAuth('cookieAuth')
  streamNotifications(
    @Req() req: AuthenticatedRequest,
    @Param('encounterId') encounterId: string,
    @Query('timeoutMs') timeoutMsRaw?: string,
  ): Observable<MessageEvent> {
    this.assertEnabled();
    const actor = actorOf(req.user);
    const parsed = Number(timeoutMsRaw);
    const timeoutMs =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30_000) : 15_000;

    return new Observable<MessageEvent>((subscriber) => {
      let cancelled = false;

      void (async () => {
        try {
          for await (const snapshot of this.events.watchNotifications(
            encounterId,
            actor,
            timeoutMs,
          )) {
            if (cancelled) break;
            // EventSource requires string `data`; Nest may leave objects opaque.
            subscriber.next({
              data: JSON.stringify(snapshot),
            } as MessageEvent);
            if (
              snapshot.status === 'complete' ||
              snapshot.status === 'timeout'
            ) {
              break;
            }
          }
          if (!cancelled) subscriber.complete();
        } catch (error) {
          if (!cancelled) subscriber.error(error);
        }
      })();

      return () => {
        cancelled = true;
      };
    });
  }

  private assertEnabled(): void {
    if (!this.events.isEnabled) {
      throw new ServiceUnavailableException(
        'Events spike disabled. Set EVENTS_ENABLED=true.',
      );
    }
  }
}
