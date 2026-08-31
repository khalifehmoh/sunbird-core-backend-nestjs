import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { Group } from '../database/entities/group.entity';
import { GroupMember } from '../database/entities/group-member.entity';
import { GroupRole } from '../database/entities/group-role.entity';
import { Role } from '../database/entities/role.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import { GroupsService } from './groups.service';

describe('GroupsService', () => {
  let groups: jest.Mocked<Repository<Group>>;
  let members: jest.Mocked<Repository<GroupMember>>;
  let groupRoles: jest.Mocked<Repository<GroupRole>>;
  let roles: jest.Mocked<Repository<Role>>;
  let users: jest.Mocked<Repository<User>>;
  let tenants: jest.Mocked<Repository<Tenant>>;
  let auditLogs: jest.Mocked<Repository<AuditLog>>;
  let service: GroupsService;
  let queryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
  };

  const tenant = {
    tenantId: '22222222-2222-4222-8222-222222222222',
    tenantName: 'Acme',
    isDeleted: false,
  } as Tenant;

  beforeEach(() => {
    queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    groups = {
      findOne: jest.fn(),
      exists: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({
        ...value,
        groupId: value.groupId ?? '11111111-1111-4111-8111-111111111111',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      })),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    } as unknown as jest.Mocked<Repository<Group>>;
    members = {
      find: jest.fn(),
      findOne: jest.fn(),
      count: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
      createQueryBuilder: jest.fn().mockReturnValue({
        ...queryBuilder,
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      }),
    } as unknown as jest.Mocked<Repository<GroupMember>>;
    groupRoles = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
      createQueryBuilder: jest.fn().mockReturnValue({
        ...queryBuilder,
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      }),
    } as unknown as jest.Mocked<Repository<GroupRole>>;
    roles = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Role>>;
    users = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<User>>;
    tenants = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Tenant>>;
    auditLogs = {
      create: jest.fn((value) => value),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<AuditLog>>;
    service = new GroupsService(
      groups,
      members,
      groupRoles,
      roles,
      users,
      tenants,
      auditLogs,
    );
  });

  it('creates a tenant-scoped group with a unique code', async () => {
    tenants.findOne.mockResolvedValue(tenant);
    groups.exists.mockResolvedValue(false);

    const result = await service.create(
      {
        tenantId: tenant.tenantId,
        groupCode: 'nurses',
        groupName: 'Nurses',
      },
      undefined,
      '33333333-3333-4333-8333-333333333333',
    );

    expect(result.groupCode).toBe('NURSES');
    expect(result.groupName).toBe('Nurses');
    expect(result.memberCount).toBe(0);
    expect(groups.save).toHaveBeenCalled();
  });

  it('rejects a duplicate group code in the same tenant', async () => {
    tenants.findOne.mockResolvedValue(tenant);
    groups.exists.mockResolvedValue(true);

    await expect(
      service.create(
        {
          tenantId: tenant.tenantId,
          groupCode: 'NURSES',
          groupName: 'Nurses',
        },
        undefined,
        '33333333-3333-4333-8333-333333333333',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects adding a user from another tenant', async () => {
    groups.findOne.mockResolvedValue({
      groupId: '11111111-1111-4111-8111-111111111111',
      tenant,
      isDeleted: false,
    } as Group);
    users.findOne.mockResolvedValue({
      userId: '44444444-4444-4444-8444-444444444444',
      tenant: {
        tenantId: '55555555-5555-4555-8555-555555555555',
      },
      isDeleted: false,
    } as User);

    await expect(
      service.addMember(
        '11111111-1111-4111-8111-111111111111',
        '44444444-4444-4444-8444-444444444444',
        undefined,
        '33333333-3333-4333-8333-333333333333',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('soft-deletes members and roles when deleting a group', async () => {
    groups.findOne.mockResolvedValue({
      groupId: '11111111-1111-4111-8111-111111111111',
      tenant,
      isDeleted: false,
    } as Group);

    await service.delete(
      '11111111-1111-4111-8111-111111111111',
      undefined,
      '33333333-3333-4333-8333-333333333333',
    );

    expect(groups.save).toHaveBeenCalledWith(
      expect.objectContaining({ isDeleted: true }),
    );
    expect(members.createQueryBuilder).toHaveBeenCalled();
    expect(groupRoles.createQueryBuilder).toHaveBeenCalled();
  });
});
