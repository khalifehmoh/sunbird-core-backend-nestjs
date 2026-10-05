import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  And,
  FindOptionsWhere,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import {
  NotificationLog,
  NotificationTemplate,
  type NotificationChannel,
  type NotificationLanguage,
  type NotificationStatus,
} from '../emr.entities';

export type LogFilter = {
  status?: NotificationStatus;
  channel?: NotificationChannel;
  eventCode?: string;
  patientId?: string;
  from?: Date;
  to?: Date;
  limit: number;
};

export type NewTemplate = Pick<
  NotificationTemplate,
  'tenantId' | 'eventCode' | 'language' | 'channel' | 'subject' | 'body'
> & { isActive?: boolean; updatedBy?: string | null };

export type NewLog = Pick<
  NotificationLog,
  | 'tenantId'
  | 'templateId'
  | 'eventCode'
  | 'channel'
  | 'language'
  | 'recipient'
  | 'patientId'
  | 'resource'
  | 'body'
>;

/** Persistence for notification templates and the delivery log. */
export abstract class NotificationStore {
  abstract templateCount(tenantId: string): Promise<number>;
  /** Inserts templates, skipping any (event, language, channel) that exists. */
  abstract insertTemplatesIfAbsent(rows: NewTemplate[]): Promise<void>;
  abstract listTemplates(tenantId: string): Promise<NotificationTemplate[]>;
  abstract findTemplate(
    tenantId: string,
    eventCode: string,
    language: NotificationLanguage,
    channel: NotificationChannel,
  ): Promise<NotificationTemplate | null>;
  abstract getTemplate(
    tenantId: string,
    templateId: string,
  ): Promise<NotificationTemplate | null>;
  abstract saveTemplate(
    template: NotificationTemplate | NewTemplate,
  ): Promise<NotificationTemplate>;
  abstract createLog(row: NewLog): Promise<NotificationLog>;
  abstract updateLog(
    notifId: string,
    patch: Partial<
      Pick<
        NotificationLog,
        'status' | 'provider' | 'attempts' | 'error' | 'sentAt'
      >
    >,
  ): Promise<void>;
  abstract listLogs(
    tenantId: string,
    filter: LogFilter,
  ): Promise<NotificationLog[]>;
}

@Injectable()
export class TypeOrmNotificationStore extends NotificationStore {
  constructor(
    @InjectRepository(NotificationTemplate)
    private readonly templates: Repository<NotificationTemplate>,
    @InjectRepository(NotificationLog)
    private readonly logs: Repository<NotificationLog>,
  ) {
    super();
  }

  templateCount(tenantId: string): Promise<number> {
    return this.templates.count({ where: { tenantId } });
  }

  async insertTemplatesIfAbsent(rows: NewTemplate[]): Promise<void> {
    if (rows.length === 0) return;
    await this.templates
      .createQueryBuilder()
      .insert()
      .into(NotificationTemplate)
      .values(rows)
      .orIgnore()
      .execute();
  }

  listTemplates(tenantId: string): Promise<NotificationTemplate[]> {
    return this.templates.find({
      where: { tenantId },
      order: { eventCode: 'ASC', language: 'ASC', channel: 'ASC' },
    });
  }

  findTemplate(
    tenantId: string,
    eventCode: string,
    language: NotificationLanguage,
    channel: NotificationChannel,
  ): Promise<NotificationTemplate | null> {
    return this.templates.findOne({
      where: { tenantId, eventCode, language, channel },
    });
  }

  getTemplate(
    tenantId: string,
    templateId: string,
  ): Promise<NotificationTemplate | null> {
    return this.templates.findOne({ where: { tenantId, templateId } });
  }

  saveTemplate(
    template: NotificationTemplate | NewTemplate,
  ): Promise<NotificationTemplate> {
    return this.templates.save(
      this.templates.create({ ...template, updatedAt: new Date() }),
    );
  }

  createLog(row: NewLog): Promise<NotificationLog> {
    return this.logs.save(this.logs.create({ ...row, status: 'PENDING' }));
  }

  async updateLog(
    notifId: string,
    patch: Parameters<NotificationStore['updateLog']>[1],
  ): Promise<void> {
    await this.logs.update({ notifId }, patch);
  }

  listLogs(tenantId: string, filter: LogFilter): Promise<NotificationLog[]> {
    const where: FindOptionsWhere<NotificationLog> = { tenantId };
    if (filter.status) where.status = filter.status;
    if (filter.channel) where.channel = filter.channel;
    if (filter.eventCode) where.eventCode = filter.eventCode;
    if (filter.patientId) where.patientId = filter.patientId;
    if (filter.from && filter.to) {
      where.createdAt = And(MoreThanOrEqual(filter.from), LessThan(filter.to));
    } else if (filter.from) {
      where.createdAt = MoreThanOrEqual(filter.from);
    } else if (filter.to) {
      where.createdAt = LessThan(filter.to);
    }
    return this.logs.find({
      where,
      order: { createdAt: 'DESC' },
      take: filter.limit,
    });
  }
}
