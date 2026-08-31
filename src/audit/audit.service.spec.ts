import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  let auditLogs: jest.Mocked<Repository<AuditLog>>;
  let users: jest.Mocked<Repository<User>>;
  let tenants: jest.Mocked<Repository<Tenant>>;
  let service: AuditService;
  let queryBuilder: {
    leftJoin: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
    getMany: jest.Mock;
    getOne: jest.Mock;
    where: jest.Mock;
  };

  const auditId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  beforeEach(() => {
    queryBuilder = {
      leftJoin: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
      getMany: jest.fn(),
      getOne: jest.fn(),
      where: jest.fn().mockReturnThis(),
    };
    auditLogs = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    } as unknown as jest.Mocked<Repository<AuditLog>>;
    users = {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Repository<User>>;
    tenants = {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Repository<Tenant>>;
    service = new AuditService(auditLogs, users, tenants);
  });

  it('rejects an unknown action type', async () => {
    await expect(
      service.findPaged(undefined, { actionType: 'HACK' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lists newest events first and maps actor usernames', async () => {
    const createdAt = new Date('2026-08-20T08:00:00Z');
    queryBuilder.getManyAndCount.mockResolvedValue([
      [
        {
          auditId,
          tenantId: null,
          userId,
          actionType: 'LOGIN',
          entityType: 'USER',
          entityId: userId,
          entityName: 'admin',
          oldValue: null,
          newValue: null,
          ipAddress: '1.1.1.1',
          userAgent: 'Chrome',
          success: true,
          errorMessage: null,
          createdAt,
        },
      ],
      1,
    ]);
    users.find.mockResolvedValue([
      {
        userId,
        username: 'admin',
        firstName: 'Ada',
        lastName: 'Admin',
        failedLoginAttempts: 0,
        accountLockedUntil: null,
        status: 'ACTIVE',
      } as User,
    ]);

    const result = await service.findPaged(undefined, {
      page: '0',
      limit: '10',
      sort: 'created_at:desc',
    });

    expect(result.totalElements).toBe(1);
    expect(result.size).toBe(10);
    expect(result.content[0]).toMatchObject({
      auditId,
      username: 'admin',
      userFullName: 'Ada Admin',
      actionType: 'LOGIN',
      entityName: 'admin',
      ipAddress: '1.1.1.1',
      oldValue: null,
      newValue: null,
    });
    expect(queryBuilder.orderBy).toHaveBeenCalledWith(
      'audit.created_at',
      'DESC',
    );
  });

  it('throws when an audit event is missing', async () => {
    queryBuilder.getOne.mockResolvedValue(null);
    await expect(service.findOne(auditId)).rejects.toThrow(NotFoundException);
  });
});
