import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { Group } from '../database/entities/group.entity';
import { GroupMember } from '../database/entities/group-member.entity';
import { GroupRole } from '../database/entities/group-role.entity';
import { Role } from '../database/entities/role.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import { TenantStatus } from '../tenants/tenant-status.enum';
import {
  GroupMemberResponseDto,
  GroupRequestDto,
  GroupResponseDto,
  GroupRoleResponseDto,
  PagedResponseDto,
} from './dto/group.dto';

export type GroupListQuery = {
  page?: string;
  size?: string;
  sort?: string;
  search?: string;
  status?: string;
  tenantId?: string;
};

const SORT_FIELDS: Record<string, string> = {
  groupCode: 'grp.group_code',
  groupName: 'grp.group_name',
  status: 'grp.status',
  createdAt: 'grp.created_at',
  tenantName: 'tenant.tenant_name',
};

@Injectable()
export class GroupsService {
  constructor(
    @InjectRepository(Group)
    private readonly groups: Repository<Group>,
    @InjectRepository(GroupMember)
    private readonly members: Repository<GroupMember>,
    @InjectRepository(GroupRole)
    private readonly groupRoles: Repository<GroupRole>,
    @InjectRepository(Role)
    private readonly roles: Repository<Role>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async findPaged(
    tenantScopeId: string | undefined,
    query: GroupListQuery,
  ): Promise<PagedResponseDto<GroupResponseDto>> {
    const page = this.parseNonNegativeInt(query.page, 0, 'page');
    const size = this.parseNonNegativeInt(query.size, 20, 'size');
    const status = this.parseStatus(query.status);
    const [sortField, sortDirection] = this.parseSort(query.sort);

    const builder = this.groups
      .createQueryBuilder('grp')
      .leftJoinAndSelect('grp.tenant', 'tenant')
      .where('grp.is_deleted = false');
    const tenantId = tenantScopeId ?? query.tenantId;
    if (tenantId) {
      builder.andWhere('grp.tenant_id = :tenantId', { tenantId });
    }
    if (status) {
      builder.andWhere('grp.status = :status', { status });
    }
    const search = query.search?.trim();
    if (search) {
      builder.andWhere(
        `(LOWER(grp.group_code) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(grp.group_name) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(COALESCE(grp.group_name_ar, '')) LIKE :search ESCAPE '\\')`,
        { search: `%${this.escapeLike(search.toLowerCase())}%` },
      );
    }

    const [content, totalElements] = await builder
      .orderBy(sortField, sortDirection)
      .skip(page * size)
      .take(size)
      .getManyAndCount();
    const counts = await this.loadCounts(content.map((group) => group.groupId));
    const totalPages = size === 0 ? 1 : Math.ceil(totalElements / size);
    return {
      content: content.map((group) =>
        this.toResponse(group, counts.get(group.groupId)),
      ),
      page,
      size,
      totalElements,
      totalPages,
      last: totalPages === 0 || page >= totalPages - 1,
    };
  }

  async findOne(
    groupId: string,
    tenantScopeId?: string,
  ): Promise<GroupResponseDto> {
    const group = await this.findGroup(groupId, tenantScopeId);
    const counts = await this.loadCounts([group.groupId]);
    return this.toResponse(group, counts.get(group.groupId));
  }

  async create(
    request: GroupRequestDto,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<GroupResponseDto> {
    const tenant = await this.resolveTenant(request.tenantId, tenantScopeId);
    const groupCode = request.groupCode.trim().toUpperCase();
    await this.ensureCodeAvailable(tenant.tenantId, groupCode);

    const saved = await this.groups.save(
      this.groups.create({
        tenant,
        groupCode,
        groupName: request.groupName.trim(),
        groupNameAr: request.groupNameAr?.trim() || null,
        groupDescription: request.groupDescription?.trim() || null,
        status: request.status ?? TenantStatus.ACTIVE,
        isDeleted: false,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      }),
    );
    await this.writeAudit(saved, actorUserId, 'CREATE');
    return this.toResponse(saved, { memberCount: 0, roleCount: 0 });
  }

  async update(
    groupId: string,
    request: GroupRequestDto,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<GroupResponseDto> {
    const group = await this.findGroup(groupId, tenantScopeId);
    if (request.tenantId !== group.tenant.tenantId) {
      throw new BadRequestException(
        'A group cannot be moved to another tenant',
      );
    }

    Object.assign(group, {
      groupName: request.groupName.trim(),
      groupNameAr: request.groupNameAr?.trim() || null,
      groupDescription: request.groupDescription?.trim() || null,
      status: request.status ?? group.status,
      updatedBy: actorUserId,
    });
    const saved = await this.groups.save(group);
    await this.writeAudit(saved, actorUserId, 'UPDATE');
    const counts = await this.loadCounts([saved.groupId]);
    return this.toResponse(saved, counts.get(saved.groupId));
  }

  async delete(
    groupId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<void> {
    const group = await this.findGroup(groupId, tenantScopeId);
    const now = new Date();
    group.isDeleted = true;
    group.deletedAt = now;
    group.deletedBy = actorUserId;
    group.updatedBy = actorUserId;
    await this.groups.save(group);

    await this.members
      .createQueryBuilder()
      .update(GroupMember)
      .set({
        isDeleted: true,
        deletedAt: now,
        deletedBy: actorUserId,
      })
      .where('group_id = :groupId', { groupId })
      .andWhere('is_deleted = false')
      .execute();
    await this.groupRoles
      .createQueryBuilder()
      .update(GroupRole)
      .set({
        isDeleted: true,
        deletedAt: now,
        deletedBy: actorUserId,
      })
      .where('group_id = :groupId', { groupId })
      .andWhere('is_deleted = false')
      .execute();

    await this.writeAudit(group, actorUserId, 'DELETE');
  }

  async listMembers(
    groupId: string,
    tenantScopeId?: string,
  ): Promise<GroupMemberResponseDto[]> {
    await this.findGroup(groupId, tenantScopeId);
    const members = await this.members.find({
      where: { group: { groupId }, isDeleted: false },
      relations: { user: true },
      order: { joinedAt: 'ASC' },
    });
    return members.map((member) => this.toMemberResponse(member));
  }

  async addMember(
    groupId: string,
    userId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<GroupMemberResponseDto> {
    const group = await this.findGroup(groupId, tenantScopeId);
    const user = await this.users.findOne({
      where: { userId, isDeleted: false },
      relations: { tenant: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.tenant?.tenantId !== group.tenant.tenantId) {
      throw new ForbiddenException(
        'Cannot add a user from another tenant to this group',
      );
    }

    const existing = await this.members.findOne({
      where: { group: { groupId }, user: { userId } },
    });
    if (existing && !existing.isDeleted) {
      throw new ConflictException('User is already a member of this group');
    }

    const saved = existing
      ? await this.members.save(
          Object.assign(existing, {
            isDeleted: false,
            deletedAt: null,
            deletedBy: null,
            joinedAt: new Date(),
            joinedBy: actorUserId,
            createdBy: actorUserId,
          }),
        )
      : await this.members.save(
          this.members.create({
            group,
            user,
            joinedBy: actorUserId,
            createdBy: actorUserId,
            isDeleted: false,
          }),
        );
    saved.user = user;
    await this.writeAudit(group, actorUserId, 'UPDATE');
    return this.toMemberResponse(saved);
  }

  async removeMember(
    groupId: string,
    userId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<void> {
    const group = await this.findGroup(groupId, tenantScopeId);
    const member = await this.members.findOne({
      where: {
        group: { groupId },
        user: { userId },
        isDeleted: false,
      },
    });
    if (!member) {
      throw new NotFoundException('Group member not found');
    }
    member.isDeleted = true;
    member.deletedAt = new Date();
    member.deletedBy = actorUserId;
    await this.members.save(member);
    await this.writeAudit(group, actorUserId, 'UPDATE');
  }

  async listRoles(
    groupId: string,
    tenantScopeId?: string,
  ): Promise<GroupRoleResponseDto[]> {
    await this.findGroup(groupId, tenantScopeId);
    const assignments = await this.groupRoles.find({
      where: { group: { groupId }, isDeleted: false },
      relations: { role: true },
      order: { assignedAt: 'ASC' },
    });
    const memberCount = await this.members.count({
      where: { group: { groupId }, isDeleted: false },
    });
    return assignments.map((assignment) =>
      this.toRoleResponse(assignment, memberCount),
    );
  }

  async assignRole(
    groupId: string,
    roleId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<GroupRoleResponseDto> {
    const group = await this.findGroup(groupId, tenantScopeId);
    const role = await this.findAssignableRole(roleId, group.tenant.tenantId);

    const existing = await this.groupRoles.findOne({
      where: { group: { groupId }, role: { roleId } },
      relations: { role: true },
    });
    if (existing && !existing.isDeleted) {
      throw new ConflictException('Role is already assigned to this group');
    }

    const saved = existing
      ? await this.groupRoles.save(
          Object.assign(existing, {
            isDeleted: false,
            deletedAt: null,
            deletedBy: null,
            assignedAt: new Date(),
            assignedBy: actorUserId,
            createdBy: actorUserId,
            role,
          }),
        )
      : await this.groupRoles.save(
          this.groupRoles.create({
            group,
            role,
            assignedBy: actorUserId,
            createdBy: actorUserId,
            isDeleted: false,
          }),
        );
    saved.role = role;
    await this.writeAudit(group, actorUserId, 'ASSIGN_ROLE');
    const memberCount = await this.members.count({
      where: { group: { groupId }, isDeleted: false },
    });
    return this.toRoleResponse(saved, memberCount);
  }

  async revokeRole(
    groupId: string,
    roleId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<void> {
    const group = await this.findGroup(groupId, tenantScopeId);
    const assignment = await this.groupRoles.findOne({
      where: {
        group: { groupId },
        role: { roleId },
        isDeleted: false,
      },
    });
    if (!assignment) {
      throw new NotFoundException('Group role not found');
    }
    assignment.isDeleted = true;
    assignment.deletedAt = new Date();
    assignment.deletedBy = actorUserId;
    await this.groupRoles.save(assignment);
    await this.writeAudit(group, actorUserId, 'REVOKE_ROLE');
  }

  private async findAssignableRole(
    roleId: string,
    tenantId: string,
  ): Promise<Role> {
    const role = await this.roles.findOne({
      where: { roleId, isDeleted: false },
      relations: { tenant: true },
    });
    if (!role || role.status !== TenantStatus.ACTIVE) {
      throw new NotFoundException('Role not found');
    }
    const roleTenantId = role.tenant?.tenantId ?? null;
    if (roleTenantId && roleTenantId !== tenantId) {
      throw new ForbiddenException('Cannot assign a role from another tenant');
    }
    return role;
  }

  private async findGroup(
    groupId: string,
    tenantScopeId?: string,
  ): Promise<Group> {
    const group = await this.groups.findOne({
      where: {
        groupId,
        isDeleted: false,
        ...(tenantScopeId ? { tenant: { tenantId: tenantScopeId } } : {}),
      },
      relations: { tenant: true },
    });
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    return group;
  }

  private async resolveTenant(
    requestedTenantId: string,
    tenantScopeId?: string,
  ): Promise<Tenant> {
    if (tenantScopeId && tenantScopeId !== requestedTenantId) {
      throw new ForbiddenException('Cannot create a group for another tenant');
    }
    const tenantId = tenantScopeId ?? requestedTenantId;
    const tenant = await this.tenants.findOne({
      where: { tenantId, isDeleted: false },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }

  private async ensureCodeAvailable(
    tenantId: string,
    groupCode: string,
  ): Promise<void> {
    if (
      await this.groups.exists({
        where: { tenant: { tenantId }, groupCode },
      })
    ) {
      throw new ConflictException('Group code already exists for this tenant');
    }
  }

  private async loadCounts(
    groupIds: string[],
  ): Promise<Map<string, { memberCount: number; roleCount: number }>> {
    const counts = new Map<
      string,
      { memberCount: number; roleCount: number }
    >();
    for (const groupId of groupIds) {
      counts.set(groupId, { memberCount: 0, roleCount: 0 });
    }
    if (groupIds.length === 0) return counts;

    const memberRows = await this.members
      .createQueryBuilder('member')
      .select('member.group_id', 'groupId')
      .addSelect('COUNT(*)', 'count')
      .where('member.group_id IN (:...groupIds)', { groupIds })
      .andWhere('member.is_deleted = false')
      .groupBy('member.group_id')
      .getRawMany<{ groupId: string; count: string }>();
    for (const row of memberRows) {
      const current = counts.get(row.groupId) ?? {
        memberCount: 0,
        roleCount: 0,
      };
      current.memberCount = Number(row.count);
      counts.set(row.groupId, current);
    }

    const roleRows = await this.groupRoles
      .createQueryBuilder('assignment')
      .select('assignment.group_id', 'groupId')
      .addSelect('COUNT(*)', 'count')
      .where('assignment.group_id IN (:...groupIds)', { groupIds })
      .andWhere('assignment.is_deleted = false')
      .groupBy('assignment.group_id')
      .getRawMany<{ groupId: string; count: string }>();
    for (const row of roleRows) {
      const current = counts.get(row.groupId) ?? {
        memberCount: 0,
        roleCount: 0,
      };
      current.roleCount = Number(row.count);
      counts.set(row.groupId, current);
    }
    return counts;
  }

  private parseStatus(raw?: string): TenantStatus | undefined {
    if (raw === undefined || raw === '') return undefined;
    if (!Object.values(TenantStatus).includes(raw as TenantStatus)) {
      throw new BadRequestException("Invalid value for parameter 'status'");
    }
    return raw as TenantStatus;
  }

  private parseSort(raw?: string): [string, 'ASC' | 'DESC'] {
    if (!raw?.trim()) return [SORT_FIELDS.groupCode, 'ASC'];
    const [field, direction] = raw.split(':').map((part) => part.trim());
    if (!SORT_FIELDS[field]) return [SORT_FIELDS.groupCode, 'ASC'];
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

  private displayName(user: User): string {
    return (
      `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.username
    );
  }

  private async writeAudit(
    group: Group,
    userId: string,
    actionType: 'CREATE' | 'UPDATE' | 'DELETE' | 'ASSIGN_ROLE' | 'REVOKE_ROLE',
  ): Promise<void> {
    await this.auditLogs.save(
      this.auditLogs.create({
        tenantId: group.tenant.tenantId,
        userId,
        actionType,
        entityType: 'GROUP',
        entityId: group.groupId,
        entityName: group.groupName,
        ipAddress: null,
        userAgent: null,
        success: true,
        errorMessage: null,
      }),
    );
  }

  private toResponse(
    group: Group,
    counts?: { memberCount: number; roleCount: number },
  ): GroupResponseDto {
    return {
      groupId: group.groupId,
      groupCode: group.groupCode,
      groupName: group.groupName,
      groupNameAr: group.groupNameAr,
      groupDescription: group.groupDescription,
      status: group.status,
      memberCount: counts?.memberCount ?? 0,
      roleCount: counts?.roleCount ?? 0,
      tenantId: group.tenant.tenantId,
      tenantName: group.tenant.tenantName ?? null,
      createdAt: group.createdAt?.toISOString() ?? null,
      updatedAt: group.updatedAt?.toISOString() ?? null,
    };
  }

  private toMemberResponse(member: GroupMember): GroupMemberResponseDto {
    return {
      memberId: member.memberId,
      userId: member.user.userId,
      username: member.user.username,
      email: member.user.email,
      fullName: this.displayName(member.user),
      joinedAt: member.joinedAt?.toISOString() ?? null,
    };
  }

  private toRoleResponse(
    assignment: GroupRole,
    inheritedMemberCount: number,
  ): GroupRoleResponseDto {
    return {
      groupRoleId: assignment.groupRoleId,
      roleId: assignment.role.roleId,
      roleCode: assignment.role.roleCode,
      roleName: assignment.role.roleName,
      roleNameAr: assignment.role.roleNameAr,
      isSystemRole: assignment.role.isSystemRole,
      assignedAt: assignment.assignedAt?.toISOString() ?? null,
      inheritedMemberCount,
    };
  }
}
