import {
  NotificationLog,
  NotificationTemplate,
  type NotificationChannel,
  type NotificationLanguage,
} from '../emr.entities';
import {
  NotificationStore,
  type LogFilter,
  type NewLog,
  type NewTemplate,
} from '../notifications/notification.store';

/** In-memory {@link NotificationStore} for specs. */
export class InMemoryNotificationStore extends NotificationStore {
  readonly templates: NotificationTemplate[] = [];
  readonly logs: NotificationLog[] = [];
  private next = 0;
  private clock = 0;

  templateCount(tenantId: string): Promise<number> {
    return Promise.resolve(
      this.templates.filter((t) => t.tenantId === tenantId).length,
    );
  }

  insertTemplatesIfAbsent(rows: NewTemplate[]): Promise<void> {
    for (const row of rows) {
      const exists = this.templates.some(
        (t) =>
          t.tenantId === row.tenantId &&
          t.eventCode === row.eventCode &&
          t.language === row.language &&
          t.channel === row.channel,
      );
      if (!exists) this.templates.push(this.makeTemplate(row));
    }
    return Promise.resolve();
  }

  listTemplates(tenantId: string): Promise<NotificationTemplate[]> {
    return Promise.resolve(
      this.templates
        .filter((t) => t.tenantId === tenantId)
        .map((t) => ({ ...t })),
    );
  }

  findTemplate(
    tenantId: string,
    eventCode: string,
    language: NotificationLanguage,
    channel: NotificationChannel,
  ): Promise<NotificationTemplate | null> {
    const found = this.templates.find(
      (t) =>
        t.tenantId === tenantId &&
        t.eventCode === eventCode &&
        t.language === language &&
        t.channel === channel,
    );
    return Promise.resolve(found ? { ...found } : null);
  }

  getTemplate(
    tenantId: string,
    templateId: string,
  ): Promise<NotificationTemplate | null> {
    const found = this.templates.find(
      (t) => t.tenantId === tenantId && t.templateId === templateId,
    );
    return Promise.resolve(found ? { ...found } : null);
  }

  saveTemplate(
    template: NotificationTemplate | NewTemplate,
  ): Promise<NotificationTemplate> {
    if ('templateId' in template) {
      const index = this.templates.findIndex(
        (t) => t.templateId === template.templateId,
      );
      this.templates[index] = { ...template, updatedAt: this.tick() };
      return Promise.resolve({ ...this.templates[index] });
    }
    const created = this.makeTemplate(template);
    this.templates.push(created);
    return Promise.resolve({ ...created });
  }

  createLog(row: NewLog): Promise<NotificationLog> {
    const log: NotificationLog = {
      ...row,
      notifId: `log-${++this.next}`,
      status: 'PENDING',
      provider: null,
      attempts: 0,
      error: null,
      createdAt: this.tick(),
      sentAt: null,
    };
    this.logs.push(log);
    return Promise.resolve({ ...log });
  }

  updateLog(
    notifId: string,
    patch: Parameters<NotificationStore['updateLog']>[1],
  ): Promise<void> {
    const log = this.logs.find((l) => l.notifId === notifId);
    if (log) Object.assign(log, patch);
    return Promise.resolve();
  }

  listLogs(tenantId: string, filter: LogFilter): Promise<NotificationLog[]> {
    return Promise.resolve(
      this.logs
        .filter(
          (l) =>
            l.tenantId === tenantId &&
            (!filter.status || l.status === filter.status) &&
            (!filter.channel || l.channel === filter.channel) &&
            (!filter.eventCode || l.eventCode === filter.eventCode) &&
            (!filter.patientId || l.patientId === filter.patientId) &&
            (!filter.from || l.createdAt >= filter.from) &&
            (!filter.to || l.createdAt < filter.to),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, filter.limit)
        .map((l) => ({ ...l })),
    );
  }

  private makeTemplate(row: NewTemplate): NotificationTemplate {
    const now = this.tick();
    return {
      templateId: `tpl-${++this.next}`,
      tenantId: row.tenantId,
      eventCode: row.eventCode,
      language: row.language,
      channel: row.channel,
      subject: row.subject ?? null,
      body: row.body,
      isActive: row.isActive ?? true,
      createdAt: now,
      updatedAt: now,
      updatedBy: row.updatedBy ?? null,
    };
  }

  private tick(): Date {
    return new Date(Date.UTC(2026, 9, 6, 9, 0, ++this.clock));
  }
}
