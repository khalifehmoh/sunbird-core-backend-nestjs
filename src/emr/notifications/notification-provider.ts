import { Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel } from '../emr.entities';

export const NOTIFICATION_PROVIDER = Symbol('NOTIFICATION_PROVIDER');

export type OutboundMessage = {
  channel: NotificationChannel;
  to: string;
  subject?: string | null;
  body: string;
};

/** Delivers one message. Throws when the provider rejects it. */
export interface NotificationProvider {
  readonly name: string;
  send(message: OutboundMessage): Promise<void>;
}

/**
 * Stand-in provider: records the message in the application log and reports
 * success. No SMS, WhatsApp or e-mail gateway is wired up yet; swapping this
 * for a real one means providing another `NOTIFICATION_PROVIDER`.
 */
@Injectable()
export class DemoNotificationProvider implements NotificationProvider {
  readonly name = 'demo';
  private readonly logger = new Logger('DemoNotificationProvider');

  send(message: OutboundMessage): Promise<void> {
    this.logger.log(`[${message.channel}] to ${message.to}: ${message.body}`);
    return Promise.resolve();
  }
}
