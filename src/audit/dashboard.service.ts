import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantStatus } from '../tenants/tenant-status.enum';
import { UserStatus } from '../auth/user-status.enum';
import { AuditLog } from '../database/entities/audit-log.entity';
import { RefreshSession } from '../database/entities/refresh-session.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import { DashboardStatsDto } from './dto/dashboard.dto';

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(RefreshSession)
    private readonly sessions: Repository<RefreshSession>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async stats(tenantScopeId?: string): Promise<DashboardStatsDto> {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const startOfChart = this.utcDayStart(-6);
    const [
      tenantCount,
      userCount,
      activeSessionCount,
      auditCount24h,
      activityRows,
    ] = await Promise.all([
      this.countTenants(tenantScopeId),
      this.countUsers(tenantScopeId),
      this.countActiveSessions(tenantScopeId),
      this.countAuditsSince(since24h, tenantScopeId),
      this.activityByDay(startOfChart, tenantScopeId),
    ]);

    return {
      tenantCount,
      userCount,
      activeSessionCount,
      auditCount24h,
      activityByDay: this.fillActivityDays(startOfChart, activityRows),
    };
  }

  private countTenants(tenantScopeId?: string): Promise<number> {
    const builder = this.tenants
      .createQueryBuilder('tenant')
      .where('tenant.is_deleted = false')
      .andWhere('tenant.status = :status', { status: TenantStatus.ACTIVE });
    if (tenantScopeId) {
      builder.andWhere('tenant.tenant_id = :tenantScopeId', { tenantScopeId });
    }
    return builder.getCount();
  }

  private countUsers(tenantScopeId?: string): Promise<number> {
    const builder = this.users
      .createQueryBuilder('user')
      .where('user.is_deleted = false')
      .andWhere('user.status = :status', { status: UserStatus.ACTIVE });
    if (tenantScopeId) {
      builder.andWhere('user.tenant_id = :tenantScopeId', { tenantScopeId });
    }
    return builder.getCount();
  }

  private countActiveSessions(tenantScopeId?: string): Promise<number> {
    const builder = this.sessions
      .createQueryBuilder('session')
      .innerJoin('session.user', 'user')
      .where('session.is_active = true')
      .andWhere('session.is_revoked = false')
      .andWhere('session.expires_at > :now', { now: new Date() })
      .andWhere('user.is_deleted = false');
    if (tenantScopeId) {
      builder.andWhere('user.tenant_id = :tenantScopeId', { tenantScopeId });
    }
    return builder.getCount();
  }

  private countAuditsSince(since: Date, tenantScopeId?: string): Promise<number> {
    const builder = this.auditLogs
      .createQueryBuilder('audit')
      .where('audit.created_at >= :since', { since });
    if (tenantScopeId) {
      builder.andWhere('audit.tenant_id = :tenantScopeId', { tenantScopeId });
    }
    return builder.getCount();
  }

  private activityByDay(
    start: Date,
    tenantScopeId?: string,
  ): Promise<Array<{ day: Date | string; count: string }>> {
    const builder = this.auditLogs
      .createQueryBuilder('audit')
      .select("DATE_TRUNC('day', audit.created_at)", 'day')
      .addSelect('COUNT(*)', 'count')
      .where('audit.created_at >= :start', { start })
      .groupBy("DATE_TRUNC('day', audit.created_at)")
      .orderBy('day', 'ASC');
    if (tenantScopeId) {
      builder.andWhere('audit.tenant_id = :tenantScopeId', { tenantScopeId });
    }
    return builder.getRawMany();
  }

  private fillActivityDays(
    start: Date,
    rows: Array<{ day: Date | string; count: string }>,
  ): Array<{ date: string; count: number }> {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const day = new Date(row.day);
      counts.set(this.utcDateKey(day), Number(row.count));
    }
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + index);
      return {
        date: WEEKDAY_SHORT[day.getUTCDay()],
        count: counts.get(this.utcDateKey(day)) ?? 0,
      };
    });
  }

  private utcDayStart(offsetDays: number): Date {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + offsetDays);
    return day;
  }

  private utcDateKey(day: Date): string {
    return day.toISOString().slice(0, 10);
  }
}
