import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { GroupRole } from '../database/entities/group-role.entity';
import { Permission } from '../database/entities/permission.entity';
import { Role } from '../database/entities/role.entity';
import { RolePermission } from '../database/entities/role-permission.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { UserRoleAssignment } from '../database/entities/user-role.entity';
import { TenantStatus } from '../tenants/tenant-status.enum';
import { RolesService } from './roles.service';

describe('RolesService', () => {
  let roles: jest.Mocked<Repository<Role>>;
  let rolePermissions: jest.Mocked<Repository<RolePermission>>;
  let permissions: jest.Mocked<Repository<Permission>>;
  let userRoles: jest.Mocked<Repository<UserRoleAssignment>>;
  let groupRoles: jest.Mocked<Repository<GroupRole>>;
  let tenants: jest.Mocked<Repository<Tenant>>;
  let auditLogs: jest.Mocked<Repository<AuditLog>>;
  let service: RolesService;
  let roleQueryBuilder: {
    leftJoinAndSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
    getCount: jest.Mock;
    addOrderBy: jest.Mock;
    getMany: jest.Mock;
  };

  const tenant = {
    tenantId: '22222222-2222-4222-8222-222222222222',
    tenantName: 'Acme',
    isDeleted: false,
  } as Tenant;

  const actorId = '33333333-3333-4333-8333-333333333333';

  function countBuilder() {
    return {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
  }

  beforeEach(() => {
    roleQueryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
      getCount: jest.fn().mockResolvedValue(0),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    roles = {
      findOne: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({
        ...value,
        roleId: value.roleId ?? '11111111-1111-4111-8111-111111111111',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      })),
      createQueryBuilder: jest.fn().mockReturnValue(roleQueryBuilder),
    } as unknown as jest.Mocked<Repository<Role>>;
    rolePermissions = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
      createQueryBuilder: jest.fn().mockReturnValue(countBuilder()),
    } as unknown as jest.Mocked<Repository<RolePermission>>;
    permissions = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Permission>>;
    userRoles = {
      createQueryBuilder: jest.fn().mockReturnValue(countBuilder()),
    } as unknown as jest.Mocked<Repository<UserRoleAssignment>>;
    groupRoles = {
      createQueryBuilder: jest.fn().mockReturnValue(countBuilder()),
    } as unknown as jest.Mocked<Repository<GroupRole>>;
    tenants = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Tenant>>;
    auditLogs = {
      create: jest.fn((value) => value),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<AuditLog>>;
    service = new RolesService(
      roles,
      rolePermissions,
      permissions,
      userRoles,
      groupRoles,
      tenants,
      auditLogs,
    );
  });

  it('creates a tenant-scoped custom role with a unique code', async () => {
    tenants.findOne.mockResolvedValue(tenant);
    roleQueryBuilder.getCount.mockResolvedValue(0);

    const result = await service.create(
      {
        tenantId: tenant.tenantId,
        roleCode: 'nurses',
        roleName: 'Nurses',
      },
      undefined,
      actorId,
    );

    expect(result.roleCode).toBe('NURSES');
    expect(result.roleName).toBe('Nurses');
    expect(result.isSystemRole).toBe(false);
    expect(result.tenantId).toBe(tenant.tenantId);
    expect(roles.save).toHaveBeenCalled();
  });

  it('creates a global custom role when no tenant is supplied', async () => {
    roleQueryBuilder.getCount.mockResolvedValue(0);

    const result = await service.create(
      {
        roleCode: 'AUDITOR',
        roleName: 'Auditor',
      },
      undefined,
      actorId,
    );

    expect(result.tenantId).toBeNull();
    expect(result.isSystemRole).toBe(false);
  });

  it('rejects a duplicate role code in the same tenant', async () => {
    tenants.findOne.mockResolvedValue(tenant);
    roleQueryBuilder.getCount.mockResolvedValue(1);

    await expect(
      service.create(
        {
          tenantId: tenant.tenantId,
          roleCode: 'NURSES',
          roleName: 'Nurses',
        },
        undefined,
        actorId,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects creating a role for another tenant', async () => {
    await expect(
      service.create(
        {
          tenantId: '55555555-5555-4555-8555-555555555555',
          roleCode: 'NURSES',
          roleName: 'Nurses',
        },
        tenant.tenantId,
        actorId,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects updates and deletes on system roles', async () => {
    const systemRole = {
      roleId: '11111111-1111-4111-8111-111111111111',
      roleCode: 'SUPER_ADMIN',
      roleName: 'Super Admin',
      isSystemRole: true,
      isDeleted: false,
      tenant: null,
      status: TenantStatus.ACTIVE,
    } as Role;
    roles.findOne.mockResolvedValue(systemRole);

    await expect(
      service.update(
        systemRole.roleId,
        { roleCode: 'SUPER_ADMIN', roleName: 'Changed' },
        undefined,
        actorId,
      ),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      service.delete(systemRole.roleId, undefined, actorId),
    ).rejects.toThrow(ForbiddenException);
  });

  it('soft-deletes a custom role', async () => {
    const customRole = {
      roleId: '11111111-1111-4111-8111-111111111111',
      roleCode: 'NURSES',
      roleName: 'Nurses',
      isSystemRole: false,
      isDeleted: false,
      tenant,
      status: TenantStatus.ACTIVE,
    } as Role;
    roles.findOne.mockResolvedValue(customRole);

    await service.delete(customRole.roleId, undefined, actorId);

    expect(roles.save).toHaveBeenCalledWith(
      expect.objectContaining({ isDeleted: true }),
    );
  });

  it('grants a permission to a custom role', async () => {
    const customRole = {
      roleId: '11111111-1111-4111-8111-111111111111',
      roleCode: 'NURSES',
      roleName: 'Nurses',
      isSystemRole: false,
      isDeleted: false,
      tenant,
      status: TenantStatus.ACTIVE,
    } as Role;
    const permission = {
      permissionId: '44444444-4444-4444-8444-444444444444',
      permissionCode: 'USER:READ',
      permissionName: 'Read users',
      operation: 'READ',
      isDeleted: false,
      module: {
        moduleId: '55555555-5555-4555-8555-555555555555',
        moduleCode: 'USER',
      },
    } as Permission;
    roles.findOne.mockResolvedValue(customRole);
    permissions.findOne.mockResolvedValue(permission);
    rolePermissions.findOne.mockResolvedValue(null);

    const result = await service.grantPermission(
      customRole.roleId,
      permission.permissionId,
      undefined,
      actorId,
    );

    expect(result.permissionCode).toBe('USER:READ');
    expect(rolePermissions.save).toHaveBeenCalled();
  });

  it('rejects tenant-scoped updates to a global custom role', async () => {
    roles.findOne.mockResolvedValue({
      roleId: '11111111-1111-4111-8111-111111111111',
      roleCode: 'AUDITOR',
      roleName: 'Auditor',
      isSystemRole: false,
      isDeleted: false,
      tenant: null,
      status: TenantStatus.ACTIVE,
    } as Role);

    await expect(
      service.update(
        '11111111-1111-4111-8111-111111111111',
        { roleCode: 'AUDITOR', roleName: 'Changed' },
        tenant.tenantId,
        actorId,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects granting permissions on a system role', async () => {
    roles.findOne.mockResolvedValue({
      roleId: '11111111-1111-4111-8111-111111111111',
      isSystemRole: true,
      isDeleted: false,
      tenant: null,
    } as Role);

    await expect(
      service.grantPermission(
        '11111111-1111-4111-8111-111111111111',
        '44444444-4444-4444-8444-444444444444',
        undefined,
        actorId,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('returns not found when revoking an unassigned permission', async () => {
    roles.findOne.mockResolvedValue({
      roleId: '11111111-1111-4111-8111-111111111111',
      isSystemRole: false,
      isDeleted: false,
      tenant,
    } as Role);
    rolePermissions.findOne.mockResolvedValue(null);

    await expect(
      service.revokePermission(
        '11111111-1111-4111-8111-111111111111',
        '44444444-4444-4444-8444-444444444444',
        undefined,
        actorId,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
