import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { ModuleEntity } from '../database/entities/module.entity';
import { Permission } from '../database/entities/permission.entity';
import { RolePermission } from '../database/entities/role-permission.entity';
import { TenantStatus } from '../tenants/tenant-status.enum';
import {
  ModuleCatalogDto,
  ModuleRequestDto,
  ModuleResponseDto,
  PagedResponseDto,
} from './dto/module.dto';

export type ModuleListQuery = {
  page?: string;
  size?: string;
  sort?: string;
  search?: string;
  status?: string;
};

const SORT_FIELDS: Record<string, string> = {
  moduleCode: 'module.module_code',
  moduleName: 'module.module_name',
  status: 'module.status',
  createdAt: 'module.created_at',
  displayOrder: 'module.display_order',
};

const MODULE_STATUSES = new Set<TenantStatus>([
  TenantStatus.ACTIVE,
  TenantStatus.INACTIVE,
]);

@Injectable()
export class ModulesService {
  constructor(
    @InjectRepository(ModuleEntity)
    private readonly modules: Repository<ModuleEntity>,
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
    @InjectRepository(RolePermission)
    private readonly rolePermissions: Repository<RolePermission>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async listCatalog(): Promise<ModuleCatalogDto[]> {
    const modules = await this.modules.find({
      where: { isDeleted: false },
      relations: { permissions: true },
      order: { displayOrder: 'ASC', moduleCode: 'ASC' },
    });
    return modules.map((module) => ({
      moduleId: module.moduleId,
      moduleCode: module.moduleCode,
      moduleName: module.moduleName,
      moduleNameAr: module.moduleNameAr,
      moduleDescription: module.moduleDescription,
      isSystemModule: module.isSystemModule,
      displayOrder: module.displayOrder,
      status: module.status,
      permissions: (module.permissions ?? [])
        .filter((permission) => !permission.isDeleted)
        .sort((a, b) => a.operation.localeCompare(b.operation))
        .map((permission) => ({
          permissionId: permission.permissionId,
          permissionCode: permission.permissionCode,
          permissionName: permission.permissionName,
          permissionNameAr: permission.permissionNameAr,
          operation: permission.operation,
        })),
    }));
  }

  async findPaged(
    query: ModuleListQuery,
  ): Promise<PagedResponseDto<ModuleResponseDto>> {
    const page = this.parseNonNegativeInt(query.page, 0, 'page');
    const size = this.parseNonNegativeInt(query.size, 20, 'size');
    const status = this.parseStatus(query.status);
    const [sortField, sortDirection] = this.parseSort(query.sort);

    const builder = this.modules
      .createQueryBuilder('module')
      .where('module.is_deleted = false');
    if (status) {
      builder.andWhere('module.status = :status', { status });
    }
    const search = query.search?.trim();
    if (search) {
      builder.andWhere(
        `(LOWER(module.module_code) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(module.module_name) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(COALESCE(module.module_name_ar, '')) LIKE :search ESCAPE '\\')`,
        { search: `%${this.escapeLike(search.toLowerCase())}%` },
      );
    }

    const [content, totalElements] = await builder
      .orderBy(sortField, sortDirection)
      .skip(page * size)
      .take(size)
      .getManyAndCount();
    const counts = await this.loadCounts(content.map((module) => module.moduleId));
    const totalPages = size === 0 ? 1 : Math.ceil(totalElements / size);
    return {
      content: content.map((module) =>
        this.toResponse(module, counts.get(module.moduleId) ?? 0),
      ),
      page,
      size,
      totalElements,
      totalPages,
      last: totalPages === 0 || page >= totalPages - 1,
    };
  }

  async findOne(moduleId: string): Promise<ModuleResponseDto> {
    const module = await this.findModule(moduleId);
    const counts = await this.loadCounts([module.moduleId]);
    return this.toResponse(module, counts.get(module.moduleId) ?? 0);
  }

  async create(
    request: ModuleRequestDto,
    actorUserId: string,
  ): Promise<ModuleResponseDto> {
    const moduleCode = request.moduleCode.trim().toUpperCase();
    await this.ensureCodeAvailable(moduleCode);

    const saved = await this.modules.save(
      this.modules.create({
        moduleCode,
        moduleName: request.moduleName.trim(),
        moduleNameAr: request.moduleNameAr?.trim() || null,
        moduleDescription: request.moduleDescription?.trim() || null,
        isSystemModule: false,
        status: this.parseCreateStatus(request.status),
        isDeleted: false,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      }),
    );
    await this.writeAudit(saved, actorUserId, 'CREATE');
    return this.toResponse(saved, 0);
  }

  async update(
    moduleId: string,
    request: ModuleRequestDto,
    actorUserId: string,
  ): Promise<ModuleResponseDto> {
    const module = await this.findModule(moduleId);
    this.assertMutable(module);

    module.moduleName = request.moduleName.trim();
    module.moduleNameAr = request.moduleNameAr?.trim() || null;
    module.moduleDescription = request.moduleDescription?.trim() || null;
    module.status = this.parseCreateStatus(request.status);
    module.updatedBy = actorUserId;
    const saved = await this.modules.save(module);
    await this.writeAudit(saved, actorUserId, 'UPDATE');
    const counts = await this.loadCounts([saved.moduleId]);
    return this.toResponse(saved, counts.get(saved.moduleId) ?? 0);
  }

  async delete(moduleId: string, actorUserId: string): Promise<void> {
    const module = await this.findModule(moduleId);
    this.assertMutable(module);

    const now = new Date();
    const children = await this.permissions.find({
      where: { module: { moduleId }, isDeleted: false },
    });
    const permissionIds = children.map((permission) => permission.permissionId);
    if (permissionIds.length > 0) {
      const assignments = await this.rolePermissions.find({
        where: {
          permission: { permissionId: In(permissionIds) },
          isDeleted: false,
        },
      });
      for (const assignment of assignments) {
        assignment.isDeleted = true;
        assignment.deletedAt = now;
        assignment.deletedBy = actorUserId;
      }
      if (assignments.length > 0) {
        await this.rolePermissions.save(assignments);
      }
      for (const permission of children) {
        permission.isDeleted = true;
        permission.deletedAt = now;
        permission.deletedBy = actorUserId;
        permission.updatedBy = actorUserId;
      }
      await this.permissions.save(children);
    }

    module.isDeleted = true;
    module.deletedAt = now;
    module.deletedBy = actorUserId;
    module.updatedBy = actorUserId;
    await this.modules.save(module);
    await this.writeAudit(module, actorUserId, 'DELETE');
  }

  private async findModule(moduleId: string): Promise<ModuleEntity> {
    const module = await this.modules.findOne({
      where: { moduleId, isDeleted: false },
    });
    if (!module) {
      throw new NotFoundException('Module not found');
    }
    return module;
  }

  private async ensureCodeAvailable(
    moduleCode: string,
    excludeModuleId?: string,
  ): Promise<void> {
    const existing = await this.modules.findOne({
      where: excludeModuleId
        ? { moduleCode, moduleId: Not(excludeModuleId) }
        : { moduleCode },
    });
    if (existing) {
      throw new ConflictException('Module code already exists');
    }
  }

  private assertMutable(module: ModuleEntity): void {
    if (module.isSystemModule) {
      throw new ForbiddenException(
        'System module — cannot be modified or deleted.',
      );
    }
  }

  private async loadCounts(moduleIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const moduleId of moduleIds) {
      counts.set(moduleId, 0);
    }
    if (moduleIds.length === 0) return counts;

    const rows = await this.permissions
      .createQueryBuilder('permission')
      .select('permission.module_id', 'moduleId')
      .addSelect('COUNT(*)', 'count')
      .where('permission.module_id IN (:...moduleIds)', { moduleIds })
      .andWhere('permission.is_deleted = false')
      .groupBy('permission.module_id')
      .getRawMany<{ moduleId: string; count: string }>();
    for (const row of rows) {
      counts.set(row.moduleId, Number(row.count));
    }
    return counts;
  }

  private parseStatus(raw?: string): TenantStatus | undefined {
    if (raw === undefined || raw === '') return undefined;
    if (!MODULE_STATUSES.has(raw as TenantStatus)) {
      throw new BadRequestException("Invalid value for parameter 'status'");
    }
    return raw as TenantStatus;
  }

  private parseCreateStatus(raw?: TenantStatus): TenantStatus {
    if (!raw) return TenantStatus.ACTIVE;
    if (!MODULE_STATUSES.has(raw)) {
      throw new BadRequestException("Invalid value for parameter 'status'");
    }
    return raw;
  }

  private parseSort(raw?: string): [string, 'ASC' | 'DESC'] {
    if (!raw?.trim()) return [SORT_FIELDS.moduleCode, 'ASC'];
    const [field, direction] = raw.split(':').map((part) => part.trim());
    if (!SORT_FIELDS[field]) return [SORT_FIELDS.moduleCode, 'ASC'];
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

  private escapeLike(raw: string): string {
    return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }

  private async writeAudit(
    module: ModuleEntity,
    userId: string,
    actionType: 'CREATE' | 'UPDATE' | 'DELETE',
  ): Promise<void> {
    await this.auditLogs.save(
      this.auditLogs.create({
        tenantId: null,
        userId,
        actionType,
        entityType: 'MODULE',
        entityId: module.moduleId,
        entityName: module.moduleName,
        ipAddress: null,
        userAgent: null,
        success: true,
        errorMessage: null,
      }),
    );
  }

  private toResponse(
    module: ModuleEntity,
    permissionCount: number,
  ): ModuleResponseDto {
    return {
      moduleId: module.moduleId,
      moduleCode: module.moduleCode,
      moduleName: module.moduleName,
      moduleNameAr: module.moduleNameAr,
      moduleDescription: module.moduleDescription,
      isSystemModule: module.isSystemModule,
      displayOrder: module.displayOrder,
      status: module.status,
      permissionCount,
      createdAt: module.createdAt?.toISOString() ?? null,
      updatedAt: module.updatedAt?.toISOString() ?? null,
    };
  }
}
