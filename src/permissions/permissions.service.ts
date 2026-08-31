import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { ModuleEntity } from '../database/entities/module.entity';
import { Permission } from '../database/entities/permission.entity';
import { RolePermission } from '../database/entities/role-permission.entity';
import {
  PagedResponseDto,
  PermissionRequestDto,
  PermissionResponseDto,
} from './dto/permission.dto';
import { PermissionOperation } from './permission-operation.enum';

export type PermissionListQuery = {
  page?: string;
  size?: string;
  sort?: string;
  moduleId?: string;
  operation?: string;
};

const SORT_FIELDS: Record<string, string> = {
  permissionCode: 'permission.permission_code',
  permissionName: 'permission.permission_name',
  operation: 'permission.operation',
  createdAt: 'permission.created_at',
  moduleName: 'module.module_name',
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class PermissionsService {
  constructor(
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
    @InjectRepository(ModuleEntity)
    private readonly modules: Repository<ModuleEntity>,
    @InjectRepository(RolePermission)
    private readonly rolePermissions: Repository<RolePermission>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async findPaged(
    query: PermissionListQuery,
  ): Promise<PagedResponseDto<PermissionResponseDto>> {
    const page = this.parseNonNegativeInt(query.page, 0, 'page');
    const size = this.parseNonNegativeInt(query.size, 20, 'size');
    const moduleId = this.parseUuid(query.moduleId, 'moduleId');
    const operation = this.parseOperation(query.operation);
    const [sortField, sortDirection] = this.parseSort(query.sort);

    const builder = this.permissions
      .createQueryBuilder('permission')
      .innerJoinAndSelect('permission.module', 'module')
      .where('permission.is_deleted = false')
      .andWhere('module.is_deleted = false');
    if (moduleId) {
      builder.andWhere('permission.module_id = :moduleId', { moduleId });
    }
    if (operation) {
      builder.andWhere('permission.operation = :operation', { operation });
    }

    const [content, totalElements] = await builder
      .orderBy(sortField, sortDirection)
      .addOrderBy('permission.permission_code', 'ASC')
      .skip(page * size)
      .take(size)
      .getManyAndCount();
    const counts = await this.loadRoleCounts(
      content.map((permission) => permission.permissionId),
    );
    const totalPages = size === 0 ? 1 : Math.ceil(totalElements / size);
    return {
      content: content.map((permission) =>
        this.toResponse(permission, counts.get(permission.permissionId) ?? 0),
      ),
      page,
      size,
      totalElements,
      totalPages,
      last: totalPages === 0 || page >= totalPages - 1,
    };
  }

  async findOne(permissionId: string): Promise<PermissionResponseDto> {
    const permission = await this.findPermission(permissionId);
    const counts = await this.loadRoleCounts([permission.permissionId]);
    return this.toResponse(
      permission,
      counts.get(permission.permissionId) ?? 0,
    );
  }

  async create(
    request: PermissionRequestDto,
    actorUserId: string,
  ): Promise<PermissionResponseDto> {
    const module = await this.requireModule(request.moduleId);
    const permissionCode = request.permissionCode.trim().toUpperCase();
    await this.ensureCodeAvailable(permissionCode);
    await this.ensureOperationAvailable(module.moduleId, request.operation);

    const saved = await this.permissions.save(
      this.permissions.create({
        module,
        permissionCode,
        permissionName: request.permissionName.trim(),
        permissionNameAr: request.permissionNameAr?.trim() || null,
        operation: request.operation,
        isDeleted: false,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      }),
    );
    saved.module = module;
    await this.writeAudit(saved, actorUserId, 'CREATE');
    return this.toResponse(saved, 0);
  }

  async update(
    permissionId: string,
    request: PermissionRequestDto,
    actorUserId: string,
  ): Promise<PermissionResponseDto> {
    const permission = await this.findPermission(permissionId);
    const module = await this.requireModule(request.moduleId);
    const permissionCode = request.permissionCode.trim().toUpperCase();
    await this.ensureCodeAvailable(permissionCode, permission.permissionId);
    await this.ensureOperationAvailable(
      module.moduleId,
      request.operation,
      permission.permissionId,
    );

    permission.module = module;
    permission.permissionCode = permissionCode;
    permission.permissionName = request.permissionName.trim();
    permission.permissionNameAr = request.permissionNameAr?.trim() || null;
    permission.operation = request.operation;
    permission.updatedBy = actorUserId;
    const saved = await this.permissions.save(permission);
    saved.module = module;
    await this.writeAudit(saved, actorUserId, 'UPDATE');
    const counts = await this.loadRoleCounts([saved.permissionId]);
    return this.toResponse(saved, counts.get(saved.permissionId) ?? 0);
  }

  async delete(permissionId: string, actorUserId: string): Promise<void> {
    const permission = await this.findPermission(permissionId);
    const roleCount = await this.rolePermissions.count({
      where: {
        permission: { permissionId },
        isDeleted: false,
      },
    });
    if (roleCount > 0) {
      throw new ConflictException(
        'Permission is assigned to one or more roles and cannot be deleted',
      );
    }

    permission.isDeleted = true;
    permission.deletedAt = new Date();
    permission.deletedBy = actorUserId;
    permission.updatedBy = actorUserId;
    await this.permissions.save(permission);
    await this.writeAudit(permission, actorUserId, 'DELETE');
  }

  private async findPermission(permissionId: string): Promise<Permission> {
    const permission = await this.permissions.findOne({
      where: { permissionId, isDeleted: false },
      relations: { module: true },
    });
    if (!permission || permission.module.isDeleted) {
      throw new NotFoundException('Permission not found');
    }
    return permission;
  }

  private async requireModule(moduleId: string): Promise<ModuleEntity> {
    const module = await this.modules.findOne({
      where: { moduleId, isDeleted: false },
    });
    if (!module) {
      throw new NotFoundException('Module not found');
    }
    return module;
  }

  private async ensureCodeAvailable(
    permissionCode: string,
    excludePermissionId?: string,
  ): Promise<void> {
    const existing = await this.permissions.findOne({
      where: excludePermissionId
        ? { permissionCode, permissionId: Not(excludePermissionId) }
        : { permissionCode },
    });
    if (existing) {
      throw new ConflictException('Permission code already exists');
    }
  }

  private async ensureOperationAvailable(
    moduleId: string,
    operation: PermissionOperation,
    excludePermissionId?: string,
  ): Promise<void> {
    const existing = await this.permissions.findOne({
      where: excludePermissionId
        ? {
            module: { moduleId },
            operation,
            permissionId: Not(excludePermissionId),
          }
        : { module: { moduleId }, operation },
    });
    if (existing) {
      throw new ConflictException(
        'A permission for this module and operation already exists',
      );
    }
  }

  private async loadRoleCounts(
    permissionIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const permissionId of permissionIds) {
      counts.set(permissionId, 0);
    }
    if (permissionIds.length === 0) return counts;

    const rows = await this.rolePermissions
      .createQueryBuilder('assignment')
      .select('assignment.permission_id', 'permissionId')
      .addSelect('COUNT(*)', 'count')
      .where('assignment.permission_id IN (:...permissionIds)', {
        permissionIds,
      })
      .andWhere('assignment.is_deleted = false')
      .groupBy('assignment.permission_id')
      .getRawMany<{ permissionId: string; count: string }>();
    for (const row of rows) {
      counts.set(row.permissionId, Number(row.count));
    }
    return counts;
  }

  private parseOperation(raw?: string): PermissionOperation | undefined {
    if (raw === undefined || raw === '') return undefined;
    if (
      !Object.values(PermissionOperation).includes(raw as PermissionOperation)
    ) {
      throw new BadRequestException("Invalid value for parameter 'operation'");
    }
    return raw as PermissionOperation;
  }

  private parseUuid(raw: string | undefined, name: string): string | undefined {
    if (raw === undefined || raw === '') return undefined;
    if (!UUID_PATTERN.test(raw)) {
      throw new BadRequestException(`Invalid value for parameter '${name}'`);
    }
    return raw;
  }

  private parseSort(raw?: string): [string, 'ASC' | 'DESC'] {
    if (!raw?.trim()) return ['module.display_order', 'ASC'];
    const [field, direction] = raw.split(':').map((part) => part.trim());
    if (!SORT_FIELDS[field]) return ['module.display_order', 'ASC'];
    return [
      SORT_FIELDS[field],
      direction?.toLowerCase() === 'asc' ? 'ASC' : 'DESC',
    ];
  }

  private parseNonNegativeInt(
    raw: string | undefined,
    fallback: number,
    name: string,
  ): number {
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BadRequestException(`Invalid value for parameter '${name}'`);
    }
    return parsed;
  }

  private async writeAudit(
    permission: Permission,
    userId: string,
    actionType: 'CREATE' | 'UPDATE' | 'DELETE',
  ): Promise<void> {
    await this.auditLogs.save(
      this.auditLogs.create({
        tenantId: null,
        userId,
        actionType,
        entityType: 'PERMISSION',
        entityId: permission.permissionId,
        entityName: permission.permissionCode,
        ipAddress: null,
        userAgent: null,
        success: true,
        errorMessage: null,
      }),
    );
  }

  private toResponse(
    permission: Permission,
    roleCount: number,
  ): PermissionResponseDto {
    return {
      permissionId: permission.permissionId,
      permissionCode: permission.permissionCode,
      permissionName: permission.permissionName,
      permissionNameAr: permission.permissionNameAr,
      operation: permission.operation,
      moduleId: permission.module.moduleId,
      moduleCode: permission.module.moduleCode,
      moduleName: permission.module.moduleName,
      moduleNameAr: permission.module.moduleNameAr,
      roleCount,
      createdAt: permission.createdAt?.toISOString() ?? null,
      updatedAt: permission.updatedAt?.toISOString() ?? null,
    };
  }
}
