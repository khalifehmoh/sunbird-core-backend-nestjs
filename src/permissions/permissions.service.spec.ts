import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { ModuleEntity } from '../database/entities/module.entity';
import { Permission } from '../database/entities/permission.entity';
import { RolePermission } from '../database/entities/role-permission.entity';
import { PermissionOperation } from './permission-operation.enum';
import { PermissionsService } from './permissions.service';

describe('PermissionsService', () => {
  let permissions: jest.Mocked<Repository<Permission>>;
  let modules: jest.Mocked<Repository<ModuleEntity>>;
  let rolePermissions: jest.Mocked<Repository<RolePermission>>;
  let auditLogs: jest.Mocked<Repository<AuditLog>>;
  let service: PermissionsService;

  const actorId = '33333333-3333-4333-8333-333333333333';
  const moduleId = '11111111-1111-4111-8111-111111111111';
  const permissionId = '44444444-4444-4444-8444-444444444444';

  const module = {
    moduleId,
    moduleCode: 'USER',
    moduleName: 'Users',
    moduleNameAr: null,
    isDeleted: false,
  } as ModuleEntity;

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
    permissions = {
      findOne: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({
        ...value,
        permissionId: value.permissionId ?? permissionId,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      })),
      createQueryBuilder: jest.fn(),
    } as unknown as jest.Mocked<Repository<Permission>>;
    modules = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<ModuleEntity>>;
    rolePermissions = {
      count: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(countBuilder()),
    } as unknown as jest.Mocked<Repository<RolePermission>>;
    auditLogs = {
      create: jest.fn((value) => value),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<AuditLog>>;
    service = new PermissionsService(
      permissions,
      modules,
      rolePermissions,
      auditLogs,
    );
  });

  it('creates a permission with a unique uppercase code', async () => {
    modules.findOne.mockResolvedValue(module);
    permissions.findOne.mockResolvedValue(null);

    const result = await service.create(
      {
        permissionCode: 'user:read',
        moduleId,
        operation: PermissionOperation.READ,
        permissionName: 'Read users',
      },
      actorId,
    );

    expect(result.permissionCode).toBe('USER:READ');
    expect(result.operation).toBe('READ');
    expect(result.moduleCode).toBe('USER');
    expect(result.roleCount).toBe(0);
  });

  it('rejects a duplicate permission code', async () => {
    modules.findOne.mockResolvedValue(module);
    permissions.findOne.mockResolvedValue({
      permissionId,
      permissionCode: 'USER:READ',
    } as Permission);

    await expect(
      service.create(
        {
          permissionCode: 'USER:READ',
          moduleId,
          operation: PermissionOperation.READ,
          permissionName: 'Read users',
        },
        actorId,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects a duplicate module and operation pair', async () => {
    modules.findOne.mockResolvedValue(module);
    permissions.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        permissionId,
        operation: 'READ',
      } as Permission);

    await expect(
      service.create(
        {
          permissionCode: 'USER:VIEW',
          moduleId,
          operation: PermissionOperation.READ,
          permissionName: 'View users',
        },
        actorId,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects delete when a role still uses the permission', async () => {
    permissions.findOne.mockResolvedValue({
      permissionId,
      isDeleted: false,
      module,
    } as Permission);
    rolePermissions.count.mockResolvedValue(2);

    await expect(service.delete(permissionId, actorId)).rejects.toThrow(
      ConflictException,
    );
  });

  it('soft-deletes a permission that is unused by roles', async () => {
    const permission = {
      permissionId,
      isDeleted: false,
      module,
    } as Permission;
    permissions.findOne.mockResolvedValue(permission);
    rolePermissions.count.mockResolvedValue(0);

    await service.delete(permissionId, actorId);

    expect(permissions.save).toHaveBeenCalledWith(
      expect.objectContaining({ isDeleted: true }),
    );
  });

  it('returns not found for a missing module on create', async () => {
    modules.findOne.mockResolvedValue(null);

    await expect(
      service.create(
        {
          permissionCode: 'USER:READ',
          moduleId,
          operation: PermissionOperation.READ,
          permissionName: 'Read users',
        },
        actorId,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
