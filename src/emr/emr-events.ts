import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { Subject, type Subscription } from 'rxjs';
import type { MedplumActor } from '../fhir/medplum-actor';

/**
 * Domain channels, named after the blueprint's `pg_notify` channels. Delivery
 * is in-process: the blueprint's database-trigger-to-listener path is replaced
 * by publishing from the service that made the change.
 */
export type EmrChannel =
  'emr.adt' | 'emr.orm' | 'emr.oru' | 'emr.sch' | 'emr.notif' | 'emr.error';

export type EmrEvent = {
  channel: EmrChannel;
  /** HL7-style code: `A01`, `S12`, `O01`, `R01`, or `patient.registered`. */
  event: string;
  tenantId: string;
  actor?: MedplumActor;
  patientId?: string;
  /** Reference to the resource the event is about, e.g. `Encounter/123`. */
  resource?: string;
  data?: Record<string, unknown>;
};

/**
 * Fire-and-forget bus. A listener that throws or rejects is logged and never
 * reaches the publisher, so a failed SMS cannot undo an admission.
 */
@Injectable()
export class EmrEventBus {
  private readonly logger = new Logger(EmrEventBus.name);
  private readonly subject = new Subject<EmrEvent>();

  publish(event: EmrEvent): void {
    this.subject.next(event);
  }

  subscribe(
    handler: (event: EmrEvent) => void | Promise<void>,
    channels?: readonly EmrChannel[],
  ): Subscription {
    return this.subject.subscribe((event) => {
      if (channels && !channels.includes(event.channel)) return;
      try {
        const result = handler(event);
        if (result) {
          result.catch((error: unknown) => this.logListenerError(event, error));
        }
      } catch (error) {
        this.logListenerError(event, error);
      }
    });
  }

  private logListenerError(event: EmrEvent, error: unknown): void {
    this.logger.error(
      `Listener failed for ${event.channel}/${event.event}: ${String(error)}`,
    );
  }
}

@Global()
@Module({
  providers: [EmrEventBus],
  exports: [EmrEventBus],
})
export class EmrCommonModule {}
