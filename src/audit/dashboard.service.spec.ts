import { Repository } from 'typeorm';
import { TenantStatus } from '../tenants/tenant-status.enum';
import { AuditLog } from '../database/entities/audit-log.entity';
import { RefreshSession } from '../database/entities/refresh-session.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import { DashboardService } from './dashboard.service';

function countBuilder(count: number) {
  return {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(count),
  };
}

describe('DashboardService', () => {
  let tenants: jest.Mocked<Repository<Tenant>>;
  let users: jest.Mocked<Repository<User>>;
  let sessions: jest.Mocked<Repository<RefreshSession>>;
  let auditLogs: jest.Mocked<Repository<AuditLog>>;
  let service: DashboardService;

  beforeEach(() => {
    tenants = {
      createQueryBuilder: jest.fn().mockReturnValue(countBuilder(4)),
    } as unknown as jest.Mocked<Repository<Tenant>>;
    users = {
      createQueryBuilder: jest.fn().mockReturnValue(countBuilder(12)),
    } as unknown as jest.Mocked<Repository<User>>;
    sessions = {
      createQueryBuilder: jest.fn().mockReturnValue(countBuilder(3)),
    } as unknown as jest.Mocked<Repository<RefreshSession>>;
    const auditBuilder = {
      ...countBuilder(9),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    auditLogs = {
      createQueryBuilder: jest.fn().mockReturnValue(auditBuilder),
    } as unknown as jest.Mocked<Repository<AuditLog>>;
    service = new DashboardService(tenants, users, sessions, auditLogs);
  });

  it('returns KPI counts and a 7-day activity series', async () => {
    const result = await service.stats();

    expect(result).toMatchObject({
      tenantCount: 4,
      userCount: 12,
      activeSessionCount: 3,
      auditCount24h: 9,
    });
    expect(result.activityByDay).toHaveLength(7);
    expect(result.activityByDay.every((day) => day.count === 0)).toBe(true);
    expect(tenants.createQueryBuilder).toHaveBeenCalled();
  });

  it('scopes tenant KPI queries for tenant users', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const tenantBuilder = countBuilder(1);
    tenants.createQueryBuilder.mockReturnValue(tenantBuilder);

    await service.stats(tenantId);

    expect(tenantBuilder.andWhere).toHaveBeenCalledWith(
      'tenant.tenant_id = :tenantScopeId',
      { tenantScopeId: tenantId },
    );
    expect(tenantBuilder.andWhere).toHaveBeenCalledWith(
      'tenant.status = :status',
      { status: TenantStatus.ACTIVE },
    );
  });
});
