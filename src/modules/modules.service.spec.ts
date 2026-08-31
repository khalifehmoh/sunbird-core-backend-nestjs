import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { ModuleEntity } from '../database/entities/module.entity';
import { Permission } from '../database/entities/permission.entity';
import { RolePermission } from '../database/entities/role-permission.entity';
import { TenantStatus } from '../tenants/tenant-status.enum';
import { ModulesService } from './modules.service';

describe('ModulesService', () => {
  let modules: jest.Mocked<Repository<ModuleEntity>>;
  let permissions: jest.Mocked<Repository<Permission>>;
  let rolePermissions: jest.Mocked<Repository<RolePermission>>;
  let auditLogs: jest.Mocked<Repository<AuditLog>>;
  let service: ModulesService;
  let moduleQueryBuilder: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };

  const actorId = '33333333-3333-4333-8333-333333333333';
  const moduleId = '11111111-1111-4111-8111-111111111111';

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
    moduleQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
    };
    modules = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({
        ...value,
        moduleId: value.moduleId ?? moduleId,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      })),
      createQueryBuilder: jest.fn().mockReturnValue(moduleQueryBuilder),
    } as unknown as jest.Mocked<Repository<ModuleEntity>>;
    permissions = {
      find: jest.fn(),
      save: jest.fn(async (value) => value),
      createQueryBuilder: jest.fn().mockReturnValue(countBuilder()),
    } as unknown as jest.Mocked<Repository<Permission>>;
    rolePermissions = {
      find: jest.fn(),
      save: jest.fn(async (value) => value),
    } as unknown as jest.Mocked<Repository<RolePermission>>;
    auditLogs = {
      create: jest.fn((value) => value),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<AuditLog>>;
    service = new ModulesService(
      modules,
      permissions,
      rolePermissions,
      auditLogs,
    );
  });

  it('creates a custom module with a unique uppercase code', async () => {
    modules.findOne.mockResolvedValue(null);

    const result = await service.create(
      { moduleCode: 'billing', moduleName: 'Billing' },
      actorId,
    );

    expect(result.moduleCode).toBe('BILLING');
    expect(result.moduleName).toBe('Billing');
    expect(result.isSystemModule).toBe(false);
    expect(result.permissionCount).toBe(0);
    expect(modules.save).toHaveBeenCalled();
  });

  it('rejects a duplicate module code', async () => {
    modules.findOne.mockResolvedValue({
      moduleId,
      moduleCode: 'BILLING',
    } as ModuleEntity);

    await expect(
      service.create({ moduleCode: 'BILLING', moduleName: 'Billing' }, actorId),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects updates and deletes on system modules', async () => {
    const systemModule = {
      moduleId,
      moduleCode: 'USER',
      moduleName: 'Users',
      isSystemModule: true,
      isDeleted: false,
      status: TenantStatus.ACTIVE,
    } as ModuleEntity;
    modules.findOne.mockResolvedValue(systemModule);

    await expect(
      service.update(
        moduleId,
        { moduleCode: 'USER', moduleName: 'Changed' },
        actorId,
      ),
    ).rejects.toThrow(ForbiddenException);

    await expect(service.delete(moduleId, actorId)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('soft-deletes a custom module and cascades to permissions', async () => {
    const customModule = {
      moduleId,
      moduleCode: 'BILLING',
      moduleName: 'Billing',
      isSystemModule: false,
      isDeleted: false,
      status: TenantStatus.ACTIVE,
    } as ModuleEntity;
    const child = {
      permissionId: '44444444-4444-4444-8444-444444444444',
      isDeleted: false,
    } as Permission;
    modules.findOne.mockResolvedValue(customModule);
    permissions.find.mockResolvedValue([child]);
    rolePermissions.find.mockResolvedValue([]);

    await service.delete(moduleId, actorId);

    expect(permissions.save).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ isDeleted: true })]),
    );
    expect(modules.save).toHaveBeenCalledWith(
      expect.objectContaining({ isDeleted: true }),
    );
  });

  it('returns not found for a missing module', async () => {
    modules.findOne.mockResolvedValue(null);

    await expect(service.findOne(moduleId)).rejects.toThrow(NotFoundException);
  });
});
