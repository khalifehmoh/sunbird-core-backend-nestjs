import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  NotificationChannel,
  NotificationLanguage,
  NotificationLog,
  NotificationTemplate,
} from '../emr.entities';
import {
  DEFAULT_TEMPLATES,
  NOTIFICATION_EVENTS,
  eventDefinition,
} from './notification-events';
import {
  NOTIFICATION_PROVIDER,
  type NotificationProvider,
} from './notification-provider';
import { NotificationStore } from './notification.store';
import type {
  CreateTemplateDto,
  NotificationLogQueryDto,
  NotificationLogRow,
  PreviewTemplateDto,
  TemplateRow,
  UpdateTemplateDto,
} from './notifications.dto';
import { placeholdersOf, renderTemplate } from './template-renderer';

const DEFAULT_LIMIT = 100;

export type SendRequest = {
  tenantId: string;
  eventCode: string;
  language: NotificationLanguage;
  channel?: NotificationChannel;
  /** Mobile number or address. `null` records a failed delivery. */
  recipient: string | null;
  patientId?: string;
  resource?: string;
  values: Record<string, string | undefined>;
};

/** Notification templates, rendering, delivery and the delivery log. */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly seeded = new Set<string>();

  constructor(
    private readonly store: NotificationStore,
    @Inject(NOTIFICATION_PROVIDER)
    private readonly provider: NotificationProvider,
  ) {}

  /** Gives a tenant the default bilingual templates the first time it needs them. */
  async ensureDefaults(tenantId: string): Promise<void> {
    if (this.seeded.has(tenantId)) return;
    if ((await this.store.templateCount(tenantId)) === 0) {
      await this.store.insertTemplatesIfAbsent(
        DEFAULT_TEMPLATES.map((template) => ({
          tenantId,
          eventCode: template.eventCode,
          language: template.language,
          channel: 'SMS' as const,
          subject: null,
          body: template.body,
        })),
      );
    }
    this.seeded.add(tenantId);
  }

  events() {
    return NOTIFICATION_EVENTS.map((event) => ({ ...event }));
  }

  async listTemplates(tenantId: string): Promise<{ items: TemplateRow[] }> {
    await this.ensureDefaults(tenantId);
    const templates = await this.store.listTemplates(tenantId);
    return { items: templates.map((template) => this.toTemplateRow(template)) };
  }

  async createTemplate(
    tenantId: string,
    dto: CreateTemplateDto,
    userId: string,
  ): Promise<TemplateRow> {
    await this.ensureDefaults(tenantId);
    this.assertPlaceholders(dto.eventCode, dto.body);
    const existing = await this.store.findTemplate(
      tenantId,
      dto.eventCode,
      dto.language,
      dto.channel,
    );
    if (existing) {
      throw new BadRequestException(
        'A template for that event, language and channel already exists; edit it instead',
      );
    }
    const saved = await this.store.saveTemplate({
      tenantId,
      eventCode: dto.eventCode,
      language: dto.language,
      channel: dto.channel,
      subject: dto.subject ?? null,
      body: dto.body,
      updatedBy: userId,
    });
    return this.toTemplateRow(saved);
  }

  async updateTemplate(
    tenantId: string,
    templateId: string,
    dto: UpdateTemplateDto,
    userId: string,
  ): Promise<TemplateRow> {
    const template = await this.store.getTemplate(tenantId, templateId);
    if (!template) throw new NotFoundException('Template not found');
    if (dto.body !== undefined) {
      this.assertPlaceholders(template.eventCode, dto.body);
      template.body = dto.body;
    }
    if (dto.subject !== undefined) template.subject = dto.subject;
    if (dto.isActive !== undefined) template.isActive = dto.isActive;
    template.updatedBy = userId;
    return this.toTemplateRow(await this.store.saveTemplate(template));
  }

  preview(dto: PreviewTemplateDto): {
    text: string;
    missing: string[];
    unknown: string[];
  } {
    const allowed = eventDefinition(dto.eventCode)?.placeholders ?? [];
    const { text, missing } = renderTemplate(dto.body, dto.values ?? {});
    return {
      text,
      missing,
      unknown: placeholdersOf(dto.body).filter(
        (name) => !allowed.includes(name),
      ),
    };
  }

  async log(
    tenantId: string,
    query: NotificationLogQueryDto,
  ): Promise<{ items: NotificationLogRow[] }> {
    const rows = await this.store.listLogs(tenantId, {
      status: query.status,
      channel: query.channel,
      eventCode: query.eventCode,
      patientId: query.patientId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit ?? DEFAULT_LIMIT,
    });
    return { items: rows.map((row) => this.toLogRow(row)) };
  }

  /**
   * Renders and delivers one notification, recording the outcome. Returns
   * `null` when the tenant has no active template for the event (nothing is
   * sent and nothing is logged). A delivery failure is recorded, not thrown.
   */
  async send(request: SendRequest): Promise<NotificationLog | null> {
    await this.ensureDefaults(request.tenantId);
    const channel = request.channel ?? 'SMS';
    const template =
      (await this.store.findTemplate(
        request.tenantId,
        request.eventCode,
        request.language,
        channel,
      )) ??
      (await this.store.findTemplate(
        request.tenantId,
        request.eventCode,
        'en',
        channel,
      ));
    if (!template?.isActive) return null;

    const { text, missing } = renderTemplate(template.body, request.values);
    if (missing.length > 0) {
      this.logger.warn(
        `${request.eventCode}: no value for ${missing.join(', ')}; sent with gaps`,
      );
    }
    const entry = await this.store.createLog({
      tenantId: request.tenantId,
      templateId: template.templateId,
      eventCode: request.eventCode,
      channel,
      language: template.language,
      recipient: request.recipient,
      patientId: request.patientId ?? null,
      resource: request.resource ?? null,
      body: text,
    });

    if (!request.recipient) {
      await this.store.updateLog(entry.notifId, {
        status: 'FAILED',
        attempts: 0,
        error: 'The patient has no mobile number on file',
      });
      return {
        ...entry,
        status: 'FAILED',
        error: 'The patient has no mobile number on file',
      };
    }

    try {
      await this.provider.send({
        channel,
        to: request.recipient,
        subject: template.subject,
        body: text,
      });
      const sentAt = new Date();
      await this.store.updateLog(entry.notifId, {
        status: 'SENT',
        provider: this.provider.name,
        attempts: 1,
        sentAt,
      });
      return {
        ...entry,
        status: 'SENT',
        provider: this.provider.name,
        attempts: 1,
        sentAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.updateLog(entry.notifId, {
        status: 'FAILED',
        provider: this.provider.name,
        attempts: 1,
        error: message,
      });
      return {
        ...entry,
        status: 'FAILED',
        provider: this.provider.name,
        attempts: 1,
        error: message,
      };
    }
  }

  private assertPlaceholders(eventCode: string, body: string): void {
    const allowed = eventDefinition(eventCode)?.placeholders;
    if (!allowed) throw new BadRequestException(`Unknown event ${eventCode}`);
    const unknown = placeholdersOf(body).filter(
      (name) => !allowed.includes(name),
    );
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown placeholder${unknown.length > 1 ? 's' : ''} ${unknown
          .map((name) => `{{${name}}}`)
          .join(
            ', ',
          )}. Available: ${allowed.map((name) => `{{${name}}}`).join(', ')}`,
      );
    }
  }

  private toTemplateRow(template: NotificationTemplate): TemplateRow {
    const event = eventDefinition(template.eventCode);
    return {
      id: template.templateId,
      eventCode: template.eventCode,
      eventLabel: event?.label ?? template.eventCode,
      language: template.language,
      channel: template.channel,
      subject: template.subject,
      body: template.body,
      isActive: template.isActive,
      placeholders: [...(event?.placeholders ?? [])],
      updatedAt: template.updatedAt.toISOString(),
    };
  }

  private toLogRow(row: NotificationLog): NotificationLogRow {
    return {
      id: row.notifId,
      eventCode: row.eventCode,
      channel: row.channel,
      language: row.language,
      recipient: row.recipient,
      patientId: row.patientId,
      body: row.body,
      status: row.status,
      provider: row.provider,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    };
  }
}
