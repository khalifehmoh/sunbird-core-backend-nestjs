import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { UserRole } from '../auth/user-role.enum';
import { UserStatus } from '../auth/user-status.enum';
import { AuditLog } from '../database/entities/audit-log.entity';
import { GroupMember } from '../database/entities/group-member.entity';
import { RefreshSession } from '../database/entities/refresh-session.entity';
import { Role } from '../database/entities/role.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import { UserRoleAssignment } from '../database/entities/user-role.entity';
import { TenantStatus } from '../tenants/tenant-status.enum';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let users: jest.Mocked<Repository<User>>;
  let tenants: jest.Mocked<Repository<Tenant>>;
  let refreshSessions: jest.Mocked<Repository<RefreshSession>>;
  let auditLogs: jest.Mocked<Repository<AuditLog>>;
  let userRoles: jest.Mocked<Repository<UserRoleAssignment>>;
  let roles: jest.Mocked<Repository<Role>>;
  let groupMembers: jest.Mocked<Repository<GroupMember>>;
  let service: UsersService;
  let queryBuilder: {
    leftJoinAndSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
    getMany: jest.Mock;
    update: jest.Mock;
    set: jest.Mock;
    execute: jest.Mock;
  };

  beforeEach(() => {
    queryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
      getMany: jest.fn(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    users = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      findOne: jest.fn(),
      exists: jest.fn(),
      count: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({
        ...value,
        userId: value.userId ?? '11111111-1111-4111-8111-111111111111',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      })),
      query: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Repository<User>>;
    tenants = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Tenant>>;
    refreshSessions = {
      find: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<RefreshSession>>;
    auditLogs = {
      create: jest.fn((value) => value),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<AuditLog>>;
    userRoles = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    } as unknown as jest.Mocked<Repository<UserRoleAssignment>>;
    roles = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Role>>;
    groupMembers = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    } as unknown as jest.Mocked<Repository<GroupMember>>;
    service = new UsersService(
      users,
      tenants,
      refreshSessions,
      auditLogs,
      userRoles,
      roles,
      groupMembers,
    );
  });

  it('rejects an invalid status filter', async () => {
    await expect(service.findPaged(undefined, { status: 'PENDING' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('prevents deleting the current user', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    await expect(service.delete(id, undefined, id)).rejects.toThrow(
      'Cannot delete your own account',
    );
  });

  it('creates a user with a temporary password and requirePasswordChange', async () => {
    users.exists.mockResolvedValue(false);
    tenants.findOne.mockResolvedValue({
      tenantId: '22222222-2222-4222-8222-222222222222',
      maxUsers: 50,
      isDeleted: false,
      tenantName: 'Acme',
    } as Tenant);
    users.count.mockResolvedValue(1);

    const result = await service.create(
      {
        tenantId: '22222222-2222-4222-8222-222222222222',
        username: 'jdoe',
        email: 'jdoe@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
      },
      undefined,
      '33333333-3333-4333-8333-333333333333',
    );

    expect(result.temporaryPassword).toBeTruthy();
    expect(result.requirePasswordChange).toBe(true);
    expect(result.fullName).toBe('Jane Doe');
    expect(users.save).toHaveBeenCalled();
  });

  it('enforces max users on create', async () => {
    users.exists.mockResolvedValue(false);
    tenants.findOne.mockResolvedValue({
      tenantId: '22222222-2222-4222-8222-222222222222',
      maxUsers: 1,
      isDeleted: false,
    } as Tenant);
    users.count.mockResolvedValue(1);

    await expect(
      service.create(
        {
          tenantId: '22222222-2222-4222-8222-222222222222',
          username: 'jdoe',
          email: 'jdoe@example.com',
          firstName: 'Jane',
          lastName: 'Doe',
        },
        undefined,
        '33333333-3333-4333-8333-333333333333',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('updates status and clears lockout when activating', async () => {
    const user = {
      userId: '11111111-1111-4111-8111-111111111111',
      status: UserStatus.LOCKED,
      failedLoginAttempts: 5,
      accountLockedUntil: new Date(),
      tenant: null,
      role: UserRole.USER,
      username: 'jdoe',
      email: 'jdoe@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      firstNameAr: null,
      lastNameAr: null,
      fullName: 'Jane Doe',
      fullNameAr: null,
      mfaEnabled: false,
      requirePasswordChange: false,
      lastLoginAt: null,
      lastLoginIp: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as User;
    users.findOne.mockResolvedValue(user);

    const result = await service.updateStatus(
      user.userId,
      UserStatus.ACTIVE,
      undefined,
      '33333333-3333-4333-8333-333333333333',
    );

    expect(result.status).toBe(UserStatus.ACTIVE);
    expect(user.failedLoginAttempts).toBe(0);
    expect(user.accountLockedUntil).toBeNull();
  });

  it('assigns a role to a user', async () => {
    const tenant = {
      tenantId: '22222222-2222-4222-8222-222222222222',
      tenantName: 'Acme',
    } as Tenant;
    const user = {
      userId: '11111111-1111-4111-8111-111111111111',
      username: 'jdoe',
      tenant,
    } as User;
    const role = {
      roleId: '44444444-4444-4444-8444-444444444444',
      roleCode: 'NURSE',
      roleName: 'Nurse',
      roleNameAr: null,
      isSystemRole: false,
      status: TenantStatus.ACTIVE,
      isDeleted: false,
      tenant,
    } as Role;
    users.findOne.mockResolvedValue(user);
    roles.findOne.mockResolvedValue(role);
    userRoles.findOne.mockResolvedValue(null);
    userRoles.save.mockImplementation(async (value) => ({
      ...value,
      userRoleId: '55555555-5555-4555-8555-555555555555',
      assignedAt: new Date('2026-01-01T00:00:00Z'),
    }));

    const result = await service.assignUserRole(
      user.userId,
      role.roleId,
      undefined,
      '33333333-3333-4333-8333-333333333333',
    );

    expect(result.roleCode).toBe('NURSE');
    expect(result.roleName).toBe('Nurse');
    expect(result.source).toBe('DIRECT');
    expect(userRoles.save).toHaveBeenCalled();
  });

  it('lists direct assignments plus roles inherited from active groups', async () => {
    const user = {
      userId: '11111111-1111-4111-8111-111111111111',
      username: 'jdoe',
    } as User;
    users.findOne.mockResolvedValue(user);
    userRoles.find.mockResolvedValue([
      {
        userRoleId: '55555555-5555-4555-8555-555555555555',
        assignedAt: new Date('2026-01-01T00:00:00Z'),
        role: {
          roleId: '44444444-4444-4444-8444-444444444444',
          roleCode: 'NURSE',
          roleName: 'Nurse',
          roleNameAr: null,
          isSystemRole: false,
          isDeleted: false,
        },
      } as UserRoleAssignment,
    ]);
    users.query.mockResolvedValue([
      {
        roleId: '77777777-7777-4777-8777-777777777777',
        roleCode: 'VIEWER',
        roleName: 'Viewer',
        roleNameAr: null,
        isSystemRole: false,
        assignedAt: '2026-02-01T00:00:00Z',
        groupId: '88888888-8888-4888-8888-888888888888',
        groupName: 'Ward A',
      },
    ]);

    const result = await service.listRoles(user.userId);

    expect(result).toEqual([
      expect.objectContaining({
        roleCode: 'NURSE',
        source: 'DIRECT',
        groupId: null,
      }),
      expect.objectContaining({
        userRoleId: null,
        roleCode: 'VIEWER',
        source: 'GROUP',
        groupId: '88888888-8888-4888-8888-888888888888',
        groupName: 'Ward A',
      }),
    ]);
    expect(users.query.mock.calls[0][0]).toContain("g.status = 'ACTIVE'");
  });

  it('computes effective permissions from active role sources only', async () => {
    users.findOne.mockResolvedValue({
      userId: '11111111-1111-4111-8111-111111111111',
      username: 'jdoe',
    } as User);
    users.query.mockResolvedValue([
      {
        permissionId: '99999999-9999-4999-8999-999999999999',
        permissionCode: 'USER:READ',
        permissionName: 'Read users',
        moduleId: '10101010-1010-4010-8010-101010101010',
        moduleCode: 'USERS',
        operation: 'READ',
        direct: true,
        inherited: 't',
      },
    ]);

    const result = await service.listEffectivePermissions(
      '11111111-1111-4111-8111-111111111111',
    );

    expect(result).toEqual([
      expect.objectContaining({
        permissionCode: 'USER:READ',
        sources: ['DIRECT', 'GROUP'],
      }),
    ]);
    const sql = String(users.query.mock.calls[0][0]);
    expect(sql).toContain('group_members');
    expect(sql).toContain("status = 'ACTIVE'");
  });

  it('rejects assigning a role from another tenant', async () => {
    users.findOne.mockResolvedValue({
      userId: '11111111-1111-4111-8111-111111111111',
      username: 'jdoe',
      tenant: { tenantId: '22222222-2222-4222-8222-222222222222' },
    } as User);
    roles.findOne.mockResolvedValue({
      roleId: '44444444-4444-4444-8444-444444444444',
      status: TenantStatus.ACTIVE,
      isDeleted: false,
      tenant: { tenantId: '66666666-6666-4666-8666-666666666666' },
    } as Role);

    await expect(
      service.assignUserRole(
        '11111111-1111-4111-8111-111111111111',
        '44444444-4444-4444-8444-444444444444',
        undefined,
        '33333333-3333-4333-8333-333333333333',
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
