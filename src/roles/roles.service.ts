import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { GroupRole } from '../database/entities/group-role.entity';
import { Permission } from '../database/entities/permission.entity';
import { Role } from '../database/entities/role.entity';
import { RolePermission } from '../database/entities/role-permission.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { UserRoleAssignment } from '../database/entities/user-role.entity';
import { TenantStatus } from '../tenants/tenant-status.enum';
import {
  BatchRolePermissionsDto,
  PagedResponseDto,
  RoleOptionDto,
  RolePermissionItemDto,
  RoleRequestDto,
  RoleResponseDto,
} from './dto/role.dto';

export type RoleListQuery = {
  page?: string;
  size?: string;
  sort?: string;
  search?: string;
  status?: string;
  isSystem?: string;
  tenantId?: string;
};

const SORT_FIELDS: Record<string, string> = {
  roleCode: 'role.role_code',
  roleName: 'role.role_name',
  status: 'role.status',
  createdAt: 'role.created_at',
  tenantName: 'tenant.tenant_name',
  isSystemRole: 'role.is_system_role',
};

const ROLE_STATUSES = new Set<TenantStatus>([
  TenantStatus.ACTIVE,
  TenantStatus.INACTIVE,
]);

type RoleCounts = {
  permissionCount: number;
  userCount: number;
  groupCount: number;
};

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(Role)
    private readonly roles: Repository<Role>,
    @InjectRepository(RolePermission)
    private readonly rolePermissions: Repository<RolePermission>,
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
    @InjectRepository(UserRoleAssignment)
    private readonly userRoles: Repository<UserRoleAssignment>,
    @InjectRepository(GroupRole)
    private readonly groupRoles: Repository<GroupRole>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async findPaged(
    tenantScopeId: string | undefined,
    query: RoleListQuery,
  ): Promise<PagedResponseDto<RoleResponseDto>> {
    const page = this.parseNonNegativeInt(query.page, 0, 'page');
    const size = this.parseNonNegativeInt(query.size, 20, 'size');
    const status = this.parseStatus(query.status);
    const isSystem = this.parseBoolean(query.isSystem, 'isSystem');
    const [sortField, sortDirection] = this.parseSort(query.sort);

    const builder = this.roles
      .createQueryBuilder('role')
      .leftJoinAndSelect('role.tenant', 'tenant')
      .where('role.is_deleted = false');
    this.applyVisibility(builder, tenantScopeId);

    if (status) {
      builder.andWhere('role.status = :status', { status });
    }
    if (isSystem !== undefined) {
      builder.andWhere('role.is_system_role = :isSystem', { isSystem });
    }
    const search = query.search?.trim();
    if (search) {
      builder.andWhere(
        `(LOWER(role.role_code) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(role.role_name) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(COALESCE(role.role_name_ar, '')) LIKE :search ESCAPE '\\')`,
        { search: `%${this.escapeLike(search.toLowerCase())}%` },
      );
    }

    const [content, totalElements] = await builder
      .orderBy(sortField, sortDirection)
      .skip(page * size)
      .take(size)
      .getManyAndCount();
    const counts = await this.loadCounts(content.map((role) => role.roleId));
    const totalPages = size === 0 ? 1 : Math.ceil(totalElements / size);
    return {
      content: content.map((role) =>
        this.toResponse(role, counts.get(role.roleId)),
      ),
      page,
      size,
      totalElements,
      totalPages,
      last: totalPages === 0 || page >= totalPages - 1,
    };
  }

  async listAssignable(
    tenantScopeId: string | undefined,
    tenantId?: string,
  ): Promise<RoleOptionDto[]> {
    const scopedTenantId = tenantScopeId ?? tenantId;
    const builder = this.roles
      .createQueryBuilder('role')
      .where('role.is_deleted = false')
      .andWhere('role.status = :status', { status: TenantStatus.ACTIVE });
    if (scopedTenantId) {
      builder.andWhere(
        '(role.tenant_id IS NULL OR role.tenant_id = :tenantId)',
        { tenantId: scopedTenantId },
      );
    } else {
      builder.andWhere('role.tenant_id IS NULL');
    }
    const roles = await builder
      .orderBy('role.is_system_role', 'DESC')
      .addOrderBy('role.role_code', 'ASC')
      .getMany();
    return roles.map((role) => ({
      roleId: role.roleId,
      roleCode: role.roleCode,
      roleName: role.roleName,
      roleNameAr: role.roleNameAr,
      isSystemRole: role.isSystemRole,
    }));
  }

  async findOne(
    roleId: string,
    tenantScopeId?: string,
  ): Promise<RoleResponseDto> {
    const role = await this.findRole(roleId, tenantScopeId);
    const counts = await this.loadCounts([role.roleId]);
    return this.toResponse(role, counts.get(role.roleId));
  }

  async create(
    request: RoleRequestDto,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<RoleResponseDto> {
    const tenant = await this.resolveTenant(request.tenantId, tenantScopeId);
    const roleCode = request.roleCode.trim().toUpperCase();
    await this.ensureCodeAvailable(tenant?.tenantId ?? null, roleCode);

    const saved = await this.roles.save(
      this.roles.create({
        tenant,
        roleCode,
        roleName: request.roleName.trim(),
        roleNameAr: request.roleNameAr?.trim() || null,
        roleDescription: request.roleDescription?.trim() || null,
        isSystemRole: false,
        status: this.parseCreateStatus(request.status),
        isDeleted: false,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      }),
    );
    saved.tenant = tenant;
    await this.writeAudit(saved, actorUserId, 'CREATE');
    return this.toResponse(saved, {
      permissionCount: 0,
      userCount: 0,
      groupCount: 0,
    });
  }

  async update(
    roleId: string,
    request: RoleRequestDto,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<RoleResponseDto> {
    const role = await this.findRole(roleId, tenantScopeId);
    this.assertMutable(role, tenantScopeId);

    role.roleName = request.roleName.trim();
    role.roleNameAr = request.roleNameAr?.trim() || null;
    role.roleDescription = request.roleDescription?.trim() || null;
    role.status = this.parseCreateStatus(request.status);
    role.updatedBy = actorUserId;
    const saved = await this.roles.save(role);
    await this.writeAudit(saved, actorUserId, 'UPDATE');
    const counts = await this.loadCounts([saved.roleId]);
    return this.toResponse(saved, counts.get(saved.roleId));
  }

  async delete(
    roleId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<void> {
    const role = await this.findRole(roleId, tenantScopeId);
    this.assertMutable(role, tenantScopeId);

    role.isDeleted = true;
    role.deletedAt = new Date();
    role.deletedBy = actorUserId;
    role.updatedBy = actorUserId;
    await this.roles.save(role);
    await this.writeAudit(role, actorUserId, 'DELETE');
  }

  async listPermissions(
    roleId: string,
    tenantScopeId?: string,
  ): Promise<RolePermissionItemDto[]> {
    await this.findRole(roleId, tenantScopeId);
    const assignments = await this.rolePermissions.find({
      where: { role: { roleId }, isDeleted: false },
      relations: { permission: { module: true } },
      order: { grantedAt: 'ASC' },
    });
    return assignments
      .filter((assignment) => !assignment.permission.isDeleted)
      .map((assignment) => this.toPermissionResponse(assignment));
  }

  async grantPermission(
    roleId: string,
    permissionId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<RolePermissionItemDto> {
    const role = await this.findRole(roleId, tenantScopeId);
    this.assertMutable(role, tenantScopeId);
    const permission = await this.findPermission(permissionId);
    const saved = await this.upsertGrant(role, permission, actorUserId);
    await this.writeAudit(role, actorUserId, 'GRANT_PERMISSION');
    return this.toPermissionResponse(saved);
  }

  async revokePermission(
    roleId: string,
    permissionId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<void> {
    const role = await this.findRole(roleId, tenantScopeId);
    this.assertMutable(role, tenantScopeId);
    const assignment = await this.rolePermissions.findOne({
      where: {
        role: { roleId },
        permission: { permissionId },
        isDeleted: false,
      },
    });
    if (!assignment) {
      throw new NotFoundException('Role permission not found');
    }
    assignment.isDeleted = true;
    assignment.deletedAt = new Date();
    assignment.deletedBy = actorUserId;
    await this.rolePermissions.save(assignment);
    await this.writeAudit(role, actorUserId, 'REVOKE_PERMISSION');
  }

  async batchPermissions(
    roleId: string,
    request: BatchRolePermissionsDto,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<RolePermissionItemDto[]> {
    const role = await this.findRole(roleId, tenantScopeId);
    this.assertMutable(role, tenantScopeId);
    if (request.revoke) {
      await this.revokeMany(role, request.permissionIds, actorUserId);
      await this.writeAudit(role, actorUserId, 'REVOKE_PERMISSION');
      return [];
    }
    const granted: RolePermissionItemDto[] = [];
    for (const permissionId of request.permissionIds) {
      const permission = await this.findPermission(permissionId);
      const saved = await this.upsertGrant(role, permission, actorUserId);
      granted.push(this.toPermissionResponse(saved));
    }
    if (request.permissionIds.length > 0) {
      await this.writeAudit(role, actorUserId, 'GRANT_PERMISSION');
    }
    return granted;
  }

  private async upsertGrant(
    role: Role,
    permission: Permission,
    actorUserId: string,
  ): Promise<RolePermission> {
    const existing = await this.rolePermissions.findOne({
      where: {
        role: { roleId: role.roleId },
        permission: { permissionId: permission.permissionId },
      },
      relations: { permission: { module: true } },
    });
    if (existing && !existing.isDeleted) {
      existing.permission = permission;
      return existing;
    }
    const saved = existing
      ? await this.rolePermissions.save(
          Object.assign(existing, {
            isDeleted: false,
            deletedAt: null,
            deletedBy: null,
            grantedAt: new Date(),
            grantedBy: actorUserId,
            createdBy: actorUserId,
            permission,
          }),
        )
      : await this.rolePermissions.save(
          this.rolePermissions.create({
            role,
            permission,
            grantedBy: actorUserId,
            createdBy: actorUserId,
            isDeleted: false,
          }),
        );
    saved.permission = permission;
    return saved;
  }

  private async revokeMany(
    role: Role,
    permissionIds: string[],
    actorUserId: string,
  ): Promise<void> {
    if (permissionIds.length === 0) return;
    const assignments = await this.rolePermissions.find({
      where: {
        role: { roleId: role.roleId },
        permission: { permissionId: In(permissionIds) },
        isDeleted: false,
      },
    });
    const now = new Date();
    for (const assignment of assignments) {
      assignment.isDeleted = true;
      assignment.deletedAt = now;
      assignment.deletedBy = actorUserId;
    }
    if (assignments.length > 0) {
      await this.rolePermissions.save(assignments);
    }
  }

  private async findRole(
    roleId: string,
    tenantScopeId?: string,
  ): Promise<Role> {
    const role = await this.roles.findOne({
      where: { roleId, isDeleted: false },
      relations: { tenant: true },
    });
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    if (
      tenantScopeId &&
      role.tenant?.tenantId &&
      role.tenant.tenantId !== tenantScopeId
    ) {
      throw new NotFoundException('Role not found');
    }
    return role;
  }

  private async findPermission(permissionId: string): Promise<Permission> {
    const permission = await this.permissions.findOne({
      where: { permissionId, isDeleted: false },
      relations: { module: true },
    });
    if (!permission) {
      throw new NotFoundException('Permission not found');
    }
    return permission;
  }

  private async resolveTenant(
    requestedTenantId: string | null | undefined,
    tenantScopeId?: string,
  ): Promise<Tenant | null> {
    if (tenantScopeId) {
      if (requestedTenantId && requestedTenantId !== tenantScopeId) {
        throw new ForbiddenException('Cannot create a role for another tenant');
      }
      return this.requireTenant(tenantScopeId);
    }
    if (!requestedTenantId) return null;
    return this.requireTenant(requestedTenantId);
  }

  private async requireTenant(tenantId: string): Promise<Tenant> {
    const tenant = await this.tenants.findOne({
      where: { tenantId, isDeleted: false },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }

  private async ensureCodeAvailable(
    tenantId: string | null,
    roleCode: string,
  ): Promise<void> {
    const builder = this.roles
      .createQueryBuilder('role')
      .where('role.role_code = :roleCode', { roleCode });
    if (tenantId) {
      builder.andWhere('role.tenant_id = :tenantId', { tenantId });
    } else {
      builder.andWhere('role.tenant_id IS NULL');
    }
    if ((await builder.getCount()) > 0) {
      throw new ConflictException(
        tenantId
          ? 'Role code already exists for this tenant'
          : 'Role code already exists for a global role',
      );
    }
  }

  private assertMutable(role: Role, tenantScopeId?: string): void {
    if (role.isSystemRole) {
      throw new ForbiddenException(
        'System role — cannot be modified or deleted.',
      );
    }
    if (tenantScopeId && !role.tenant?.tenantId) {
      throw new ForbiddenException('Cannot modify a global role');
    }
  }

  private applyVisibility(
    builder: ReturnType<Repository<Role>['createQueryBuilder']>,
    tenantScopeId?: string,
  ): void {
    if (!tenantScopeId) return;
    builder.andWhere(
      '(role.tenant_id IS NULL OR role.tenant_id = :tenantScopeId)',
      { tenantScopeId },
    );
  }

  private async loadCounts(
    roleIds: string[],
  ): Promise<Map<string, RoleCounts>> {
    const counts = new Map<string, RoleCounts>();
    for (const roleId of roleIds) {
      counts.set(roleId, { permissionCount: 0, userCount: 0, groupCount: 0 });
    }
    if (roleIds.length === 0) return counts;

    const permissionRows = await this.rolePermissions
      .createQueryBuilder('assignment')
      .select('assignment.role_id', 'roleId')
      .addSelect('COUNT(*)', 'count')
      .where('assignment.role_id IN (:...roleIds)', { roleIds })
      .andWhere('assignment.is_deleted = false')
      .groupBy('assignment.role_id')
      .getRawMany<{ roleId: string; count: string }>();
    for (const row of permissionRows) {
      const current = counts.get(row.roleId) ?? {
        permissionCount: 0,
        userCount: 0,
        groupCount: 0,
      };
      current.permissionCount = Number(row.count);
      counts.set(row.roleId, current);
    }

    const userRows = await this.userRoles
      .createQueryBuilder('assignment')
      .select('assignment.role_id', 'roleId')
      .addSelect('COUNT(*)', 'count')
      .where('assignment.role_id IN (:...roleIds)', { roleIds })
      .andWhere('assignment.is_deleted = false')
      .groupBy('assignment.role_id')
      .getRawMany<{ roleId: string; count: string }>();
    for (const row of userRows) {
      const current = counts.get(row.roleId) ?? {
        permissionCount: 0,
        userCount: 0,
        groupCount: 0,
      };
      current.userCount = Number(row.count);
      counts.set(row.roleId, current);
    }

    const groupRows = await this.groupRoles
      .createQueryBuilder('assignment')
      .select('assignment.role_id', 'roleId')
      .addSelect('COUNT(*)', 'count')
      .where('assignment.role_id IN (:...roleIds)', { roleIds })
      .andWhere('assignment.is_deleted = false')
      .groupBy('assignment.role_id')
      .getRawMany<{ roleId: string; count: string }>();
    for (const row of groupRows) {
      const current = counts.get(row.roleId) ?? {
        permissionCount: 0,
        userCount: 0,
        groupCount: 0,
      };
      current.groupCount = Number(row.count);
      counts.set(row.roleId, current);
    }
    return counts;
  }

  private parseStatus(raw?: string): TenantStatus | undefined {
    if (raw === undefined || raw === '') return undefined;
    if (!ROLE_STATUSES.has(raw as TenantStatus)) {
      throw new BadRequestException("Invalid value for parameter 'status'");
    }
    return raw as TenantStatus;
  }

  private parseCreateStatus(raw?: TenantStatus): TenantStatus {
    if (!raw) return TenantStatus.ACTIVE;
    if (!ROLE_STATUSES.has(raw)) {
      throw new BadRequestException("Invalid value for parameter 'status'");
    }
    return raw;
  }

  private parseBoolean(
    raw: string | undefined,
    name: string,
  ): boolean | undefined {
    if (raw === undefined || raw === '') return undefined;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new BadRequestException(`Invalid value for parameter '${name}'`);
  }

  private parseSort(raw?: string): [string, 'ASC' | 'DESC'] {
    if (!raw?.trim()) return [SORT_FIELDS.roleCode, 'ASC'];
    const [field, direction] = raw.split(':').map((part) => part.trim());
    if (!SORT_FIELDS[field]) return [SORT_FIELDS.roleCode, 'ASC'];
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
    role: Role,
    userId: string,
    actionType:
      'CREATE' | 'UPDATE' | 'DELETE' | 'GRANT_PERMISSION' | 'REVOKE_PERMISSION',
  ): Promise<void> {
    await this.auditLogs.save(
      this.auditLogs.create({
        tenantId: role.tenant?.tenantId ?? null,
        userId,
        actionType,
        entityType: 'ROLE',
        entityId: role.roleId,
        entityName: role.roleName,
        ipAddress: null,
        userAgent: null,
        success: true,
        errorMessage: null,
      }),
    );
  }

  private toResponse(role: Role, counts?: RoleCounts): RoleResponseDto {
    return {
      roleId: role.roleId,
      roleCode: role.roleCode,
      roleName: role.roleName,
      roleNameAr: role.roleNameAr,
      roleDescription: role.roleDescription,
      isSystemRole: role.isSystemRole,
      status: role.status,
      tenantId: role.tenant?.tenantId ?? null,
      tenantName: role.tenant?.tenantName ?? null,
      permissionCount: counts?.permissionCount ?? 0,
      userCount: counts?.userCount ?? 0,
      groupCount: counts?.groupCount ?? 0,
      createdAt: role.createdAt?.toISOString() ?? null,
      updatedAt: role.updatedAt?.toISOString() ?? null,
    };
  }

  private toPermissionResponse(
    assignment: RolePermission,
  ): RolePermissionItemDto {
    return {
      permissionId: assignment.permission.permissionId,
      permissionCode: assignment.permission.permissionCode,
      permissionName: assignment.permission.permissionName,
      moduleId: assignment.permission.module.moduleId,
      moduleCode: assignment.permission.module.moduleCode,
      operation: assignment.permission.operation,
      grantedAt: assignment.grantedAt?.toISOString() ?? null,
    };
  }
}
