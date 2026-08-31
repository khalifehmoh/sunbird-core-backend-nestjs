import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { ACTIVE_ROLE_SOURCES_SQL } from '../auth/effective-access.query';
import { toApiRole, toDumpRoleCode } from '../auth/user-role.enum';
import { UserStatus } from '../auth/user-status.enum';
import { AuditLog } from '../database/entities/audit-log.entity';
import { GroupMember } from '../database/entities/group-member.entity';
import { RefreshSession } from '../database/entities/refresh-session.entity';
import { Role } from '../database/entities/role.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import { UserRoleAssignment } from '../database/entities/user-role.entity';
import { TenantStatus } from '../tenants/tenant-status.enum';
import {
  PagedResponseDto,
  ActiveSessionResponseDto,
  EffectivePermissionDto,
  UserGroupResponseDto,
  UserRequestDto,
  UserResponseDto,
  UserRoleResponseDto,
  UserSessionResponseDto,
} from './dto/user.dto';

export type ActiveSessionListQuery = {
  page?: string;
  size?: string;
  search?: string;
};

export type UserListQuery = {
  page?: string;
  size?: string;
  sort?: string;
  search?: string;
  status?: string;
  tenantId?: string;
  username?: string;
  email?: string;
};

const SORT_FIELDS: Record<string, string> = {
  username: 'user.username',
  email: 'user.email',
  firstName: 'user.first_name',
  lastName: 'user.last_name',
  status: 'user.status',
  lastLoginAt: 'user.last_login_at',
  createdAt: 'user.created_at',
  tenantName: 'tenant.tenant_name',
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @InjectRepository(RefreshSession)
    private readonly refreshSessions: Repository<RefreshSession>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    @InjectRepository(UserRoleAssignment)
    private readonly userRoles: Repository<UserRoleAssignment>,
    @InjectRepository(Role)
    private readonly roles: Repository<Role>,
    @InjectRepository(GroupMember)
    private readonly groupMembers: Repository<GroupMember>,
  ) {}

  async findPaged(
    tenantScopeId: string | undefined,
    query: UserListQuery,
  ): Promise<PagedResponseDto<UserResponseDto>> {
    const page = this.parseNonNegativeInt(query.page, 0, 'page');
    const size = this.parseNonNegativeInt(query.size, 20, 'size');
    const status = this.parseStatus(query.status);
    const [sortField, sortDirection] = this.parseSort(query.sort);

    const builder = this.users
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.tenant', 'tenant')
      .where('user.is_deleted = false');

    const tenantId = tenantScopeId ?? query.tenantId;
    if (tenantId) {
      builder.andWhere('user.tenant_id = :tenantId', { tenantId });
    }
    if (status) {
      builder.andWhere('user.status = :status', { status });
    }
    if (query.username?.trim()) {
      builder.andWhere('LOWER(user.username) = :username', {
        username: query.username.trim().toLowerCase(),
      });
    }
    if (query.email?.trim()) {
      builder.andWhere('LOWER(user.email) = :email', {
        email: query.email.trim().toLowerCase(),
      });
    }
    const search = query.search?.trim();
    if (search) {
      builder.andWhere(
        `(LOWER(user.username) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(user.email) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(COALESCE(user.first_name, '')) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(COALESCE(user.last_name, '')) LIKE :search ESCAPE '\\')`,
        { search: `%${this.escapeLike(search.toLowerCase())}%` },
      );
    }

    const [content, totalElements] = await builder
      .orderBy(sortField, sortDirection)
      .skip(page * size)
      .take(size)
      .getManyAndCount();
    await this.attachRoles(content);
    const totalPages = size === 0 ? 1 : Math.ceil(totalElements / size);
    return {
      content: content.map((user) => this.toResponse(user)),
      page,
      size,
      totalElements,
      totalPages,
      last: totalPages === 0 || page >= totalPages - 1,
    };
  }

  async findOne(
    userId: string,
    tenantScopeId?: string,
  ): Promise<UserResponseDto> {
    const user = await this.findUser(userId, tenantScopeId);
    await this.attachRoles([user]);
    return this.toResponse(user);
  }

  async create(
    request: UserRequestDto,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<UserResponseDto> {
    const username = request.username.trim().toLowerCase();
    const email = request.email.trim().toLowerCase();
    await this.ensureUsernameAvailable(username);
    await this.ensureEmailAvailable(email);

    const tenant = await this.resolveTenant(
      request.tenantId,
      tenantScopeId,
    );
    if (!tenant) {
      throw new BadRequestException('Tenant is required');
    }
    await this.ensureMaxUsers(tenant);

    const temporaryPassword = this.generateTempPassword();
    const firstName = request.firstName.trim();
    const lastName = request.lastName.trim();

    const user = await this.users.save(
      this.users.create({
        username,
        email,
        passwordHash: await bcrypt.hash(temporaryPassword, 10),
        firstName,
        lastName,
        firstNameAr: request.firstNameAr?.trim() || null,
        lastNameAr: request.lastNameAr?.trim() || null,
        status: request.status ?? UserStatus.ACTIVE,
        mfaEnabled: request.mfaEnabled ?? false,
        requirePasswordChange: true,
        isDeleted: false,
        tenant: tenant,
      }),
    );
    await this.assignRole(
      user.userId,
      toDumpRoleCode(request.role, Boolean(tenant)),
    );
    user.role = toDumpRoleCode(request.role, Boolean(tenant));

    this.logger.log(
      `Created user ${username}; welcome email stubbed (temp password issued once)`,
    );
    await this.writeAudit(user, actorUserId, 'CREATE');
    return this.toResponse(user, temporaryPassword);
  }

  async update(
    userId: string,
    request: UserRequestDto,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<UserResponseDto> {
    const user = await this.findUser(userId, tenantScopeId);
    const email = request.email.trim().toLowerCase();
    if (email !== user.email.toLowerCase()) {
      await this.ensureEmailAvailable(email, userId);
    }

    const firstName = request.firstName.trim();
    const lastName = request.lastName.trim();

    Object.assign(user, {
      email,
      firstName,
      lastName,
      firstNameAr: request.firstNameAr?.trim() || null,
      lastNameAr: request.lastNameAr?.trim() || null,
      status: request.status ?? user.status,
      mfaEnabled:
        request.mfaEnabled !== undefined
          ? request.mfaEnabled
          : user.mfaEnabled,
    });

    const saved = await this.users.save(user);
    if (request.role) {
      await this.assignRole(
        saved.userId,
        toDumpRoleCode(request.role, Boolean(saved.tenant)),
      );
      saved.role = toDumpRoleCode(request.role, Boolean(saved.tenant));
    } else {
      await this.attachRoles([saved]);
    }
    await this.writeAudit(saved, actorUserId, 'UPDATE');
    return this.toResponse(saved);
  }

  async updateStatus(
    userId: string,
    status: UserStatus,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<UserResponseDto> {
    const user = await this.findUser(userId, tenantScopeId);
    user.status = status;
    if (status === UserStatus.ACTIVE) {
      user.failedLoginAttempts = 0;
      user.accountLockedUntil = null;
    }
    const saved = await this.users.save(user);
    if (status === UserStatus.LOCKED || status === UserStatus.INACTIVE) {
      await this.revokeAllSessions(userId);
    }
    await this.writeAudit(saved, actorUserId, 'UPDATE');
    return this.toResponse(saved);
  }

  async bulkUpdateStatus(
    userIds: string[],
    status: UserStatus,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<{ updated: number }> {
    const uniqueIds = [...new Set(userIds)];
    const builder = this.users
      .createQueryBuilder('user')
      .where('user.is_deleted = false')
      .andWhere('user.user_id IN (:...ids)', { ids: uniqueIds });
    if (tenantScopeId) {
      builder.andWhere('user.tenant_id = :tenantScopeId', { tenantScopeId });
    }
    const users = await builder.getMany();
    if (users.length === 0) {
      return { updated: 0 };
    }
    for (const user of users) {
      user.status = status;
      if (status === UserStatus.ACTIVE) {
        user.failedLoginAttempts = 0;
        user.accountLockedUntil = null;
      }
    }
    await this.users.save(users);
    if (status === UserStatus.LOCKED || status === UserStatus.INACTIVE) {
      await this.refreshSessions
        .createQueryBuilder()
        .update(RefreshSession)
        .set({
          isRevoked: true,
          isActive: false,
          logoutAt: new Date(),
        })
        .where('user_id IN (:...ids)', {
          ids: users.map((user) => user.userId),
        })
        .andWhere('is_active = true')
        .execute();
    }
    for (const user of users) {
      await this.writeAudit(user, actorUserId, 'UPDATE');
    }
    return { updated: users.length };
  }

  async resetPassword(
    userId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<UserResponseDto> {
    const user = await this.findUser(userId, tenantScopeId);
    const temporaryPassword = this.generateTempPassword();
    user.passwordHash = await bcrypt.hash(temporaryPassword, 10);
    user.requirePasswordChange = true;
    user.passwordLastChangedAt = new Date();
    const saved = await this.users.save(user);
    await this.revokeAllSessions(userId);
    this.logger.log(`Password reset for user ${user.username}; email stubbed`);
    await this.writeAudit(saved, actorUserId, 'UPDATE');
    return this.toResponse(saved, temporaryPassword);
  }

  async delete(
    userId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<void> {
    if (userId === actorUserId) {
      throw new BadRequestException('Cannot delete your own account');
    }
    const user = await this.findUser(userId, tenantScopeId);
    user.isDeleted = true;
    await this.users.save(user);
    await this.revokeAllSessions(userId);
    await this.writeAudit(user, actorUserId, 'DELETE');
  }

  async listActiveSessions(
    tenantScopeId: string | undefined,
    query: ActiveSessionListQuery,
  ): Promise<PagedResponseDto<ActiveSessionResponseDto>> {
    const page = this.parseNonNegativeInt(query.page, 0, 'page');
    const size = this.parseNonNegativeInt(query.size, 20, 'size');
    const now = new Date();
    const builder = this.refreshSessions
      .createQueryBuilder('session')
      .innerJoinAndSelect('session.user', 'user')
      .leftJoinAndSelect('user.tenant', 'tenant')
      .where('session.is_active = true')
      .andWhere('session.is_revoked = false')
      .andWhere('session.expires_at > :now', { now })
      .andWhere('user.is_deleted = false');
    if (tenantScopeId) {
      builder.andWhere('user.tenant_id = :tenantScopeId', { tenantScopeId });
    }
    const search = query.search?.trim();
    if (search) {
      builder.andWhere(
        `(LOWER(user.username) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(COALESCE(user.first_name, '')) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(COALESCE(user.last_name, '')) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(COALESCE(session.ip_address, '')) LIKE :search ESCAPE '\\')`,
        { search: `%${this.escapeLike(search.toLowerCase())}%` },
      );
    }
    const [content, totalElements] = await builder
      .orderBy('session.last_activity_at', 'DESC', 'NULLS LAST')
      .addOrderBy('session.created_at', 'DESC')
      .skip(page * size)
      .take(size)
      .getManyAndCount();
    const totalPages = size === 0 ? 1 : Math.ceil(totalElements / size);
    return {
      content: content.map((session) => this.toActiveSessionResponse(session)),
      page,
      size,
      totalElements,
      totalPages,
      last: totalPages === 0 || page >= totalPages - 1,
    };
  }

  async listSessions(
    userId: string,
    tenantScopeId?: string,
  ): Promise<UserSessionResponseDto[]> {
    await this.findUser(userId, tenantScopeId);
    const sessions = await this.refreshSessions.find({
      where: { user: { userId } },
      order: { createdAt: 'DESC' },
    });
    return sessions.map((session) => this.toSessionResponse(session));
  }

  async terminateSession(
    sessionId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<void> {
    const session = await this.refreshSessions.findOne({
      where: { sessionId },
      relations: { user: { tenant: true } },
    });
    if (!session) {
      throw new NotFoundException('Session not found');
    }
    if (
      tenantScopeId &&
      session.user.tenant?.tenantId &&
      session.user.tenant.tenantId !== tenantScopeId
    ) {
      throw new ForbiddenException('Cannot terminate session for another tenant');
    }
    if (session.user.isDeleted) {
      throw new NotFoundException('Session not found');
    }
    session.isRevoked = true;
    session.isActive = false;
    session.logoutAt = new Date();
    await this.refreshSessions.save(session);
    await this.writeAudit(session.user, actorUserId, 'UPDATE');
  }

  async terminateAllSessions(
    userId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<{ terminated: number }> {
    const user = await this.findUser(userId, tenantScopeId);
    const result = await this.revokeAllSessions(userId);
    await this.writeAudit(user, actorUserId, 'UPDATE');
    return { terminated: result };
  }

  async listRoles(
    userId: string,
    tenantScopeId?: string,
  ): Promise<UserRoleResponseDto[]> {
    await this.findUser(userId, tenantScopeId);
    const assignments = await this.userRoles.find({
      where: { user: { userId }, isDeleted: false },
      relations: { role: true },
      order: { assignedAt: 'ASC' },
    });
    const direct = assignments
      .filter((assignment) => !assignment.role.isDeleted)
      .map((assignment) => this.toRoleResponse(assignment));

    const inherited = await this.users.query<
      Array<{
        roleId: string;
        roleCode: string;
        roleName: string;
        roleNameAr: string | null;
        isSystemRole: boolean;
        assignedAt: Date | string | null;
        groupId: string;
        groupName: string;
      }>
    >(
      `SELECT
         r.role_id AS "roleId",
         r.role_code AS "roleCode",
         r.role_name AS "roleName",
         r.role_name_ar AS "roleNameAr",
         r.is_system_role AS "isSystemRole",
         gr.assigned_at AS "assignedAt",
         g.group_id AS "groupId",
         g.group_name AS "groupName"
       FROM core.group_members gm
       JOIN core.groups g
         ON g.group_id = gm.group_id
        AND g.is_deleted = false
        AND g.status = 'ACTIVE'
       JOIN core.group_roles gr
         ON gr.group_id = gm.group_id
        AND gr.is_deleted = false
       JOIN core.roles r
         ON r.role_id = gr.role_id
        AND r.is_deleted = false
        AND r.status = 'ACTIVE'
      WHERE gm.user_id = $1
        AND gm.is_deleted = false
      ORDER BY r.role_code, g.group_name`,
      [userId],
    );

    return [
      ...direct,
      ...inherited.map((row) => ({
        userRoleId: null,
        roleId: row.roleId,
        roleCode: row.roleCode,
        roleName: row.roleName,
        roleNameAr: row.roleNameAr,
        isSystemRole: this.isTruthy(row.isSystemRole as unknown as boolean | string),
        assignedAt:
          row.assignedAt instanceof Date
            ? row.assignedAt.toISOString()
            : row.assignedAt
              ? new Date(row.assignedAt).toISOString()
              : null,
        source: 'GROUP' as const,
        groupId: row.groupId,
        groupName: row.groupName,
      })),
    ];
  }

  async assignUserRole(
    userId: string,
    roleId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<UserRoleResponseDto> {
    const user = await this.findUser(userId, tenantScopeId);
    const role = await this.findAssignableRole(
      roleId,
      user.tenant?.tenantId ?? null,
    );

    const existing = await this.userRoles.findOne({
      where: { user: { userId }, role: { roleId } },
      relations: { role: true },
    });
    if (existing && !existing.isDeleted) {
      throw new ConflictException('Role is already assigned to this user');
    }

    const saved = existing
      ? await this.userRoles.save(
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
      : await this.userRoles.save(
          this.userRoles.create({
            user,
            role,
            assignedBy: actorUserId,
            createdBy: actorUserId,
            isDeleted: false,
          }),
        );
    saved.role = role;
    await this.writeAudit(user, actorUserId, 'ASSIGN_ROLE');
    return this.toRoleResponse(saved);
  }

  async revokeUserRole(
    userId: string,
    roleId: string,
    tenantScopeId: string | undefined,
    actorUserId: string,
  ): Promise<void> {
    const user = await this.findUser(userId, tenantScopeId);
    const assignment = await this.userRoles.findOne({
      where: {
        user: { userId },
        role: { roleId },
        isDeleted: false,
      },
    });
    if (!assignment) {
      throw new NotFoundException('User role not found');
    }
    assignment.isDeleted = true;
    assignment.deletedAt = new Date();
    assignment.deletedBy = actorUserId;
    await this.userRoles.save(assignment);
    await this.writeAudit(user, actorUserId, 'REVOKE_ROLE');
  }

  async listGroups(
    userId: string,
    tenantScopeId?: string,
  ): Promise<UserGroupResponseDto[]> {
    await this.findUser(userId, tenantScopeId);
    const memberships = await this.groupMembers.find({
      where: {
        user: { userId },
        isDeleted: false,
        group: { isDeleted: false },
      },
      relations: { group: true },
      order: { joinedAt: 'ASC' },
    });
    return memberships.map((membership) => this.toGroupResponse(membership));
  }

  async listEffectivePermissions(
    userId: string,
    tenantScopeId?: string,
  ): Promise<EffectivePermissionDto[]> {
    await this.findUser(userId, tenantScopeId);
    const rows = await this.users.query<
      Array<{
        permissionId: string;
        permissionCode: string;
        permissionName: string;
        moduleId: string;
        moduleCode: string;
        operation: string;
        direct: boolean | string;
        inherited: boolean | string;
      }>
    >(
      `SELECT
         p.permission_id AS "permissionId",
         p.permission_code AS "permissionCode",
         p.permission_name AS "permissionName",
         m.module_id AS "moduleId",
         m.module_code AS "moduleCode",
         p.operation AS "operation",
         BOOL_OR(src.source = 'DIRECT') AS "direct",
         BOOL_OR(src.source = 'GROUP') AS "inherited"
       FROM (${ACTIVE_ROLE_SOURCES_SQL}) src
       JOIN core.role_permissions rp
         ON rp.role_id = src.role_id AND rp.is_deleted = false
       JOIN core.permissions p
         ON p.permission_id = rp.permission_id AND p.is_deleted = false
       JOIN core.modules m
         ON m.module_id = p.module_id AND m.is_deleted = false
       GROUP BY
         p.permission_id, p.permission_code, p.permission_name,
         m.module_id, m.module_code, p.operation
       ORDER BY m.module_code, p.permission_code`,
      [userId],
    );
    return rows.map((row) => {
      const sources: Array<'DIRECT' | 'GROUP'> = [];
      if (this.isTruthy(row.direct)) sources.push('DIRECT');
      if (this.isTruthy(row.inherited)) sources.push('GROUP');
      return {
        permissionId: row.permissionId,
        permissionCode: row.permissionCode,
        permissionName: row.permissionName,
        moduleId: row.moduleId,
        moduleCode: row.moduleCode,
        operation: row.operation,
        sources,
      };
    });
  }

  private async findAssignableRole(
    roleId: string,
    tenantId: string | null,
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

  private toRoleResponse(assignment: UserRoleAssignment): UserRoleResponseDto {
    return {
      userRoleId: assignment.userRoleId,
      roleId: assignment.role.roleId,
      roleCode: assignment.role.roleCode,
      roleName: assignment.role.roleName,
      roleNameAr: assignment.role.roleNameAr,
      isSystemRole: assignment.role.isSystemRole,
      assignedAt: assignment.assignedAt?.toISOString() ?? null,
      source: 'DIRECT',
      groupId: null,
      groupName: null,
    };
  }

  private toGroupResponse(member: GroupMember): UserGroupResponseDto {
    return {
      memberId: member.memberId,
      groupId: member.group.groupId,
      groupCode: member.group.groupCode,
      groupName: member.group.groupName,
      groupNameAr: member.group.groupNameAr,
      status: member.group.status,
      joinedAt: member.joinedAt?.toISOString() ?? null,
    };
  }

  private isTruthy(value: boolean | string): boolean {
    return value === true || value === 't' || value === 'true';
  }

  private async revokeAllSessions(userId: string): Promise<number> {
    const result = await this.refreshSessions
      .createQueryBuilder()
      .update(RefreshSession)
      .set({
        isRevoked: true,
        isActive: false,
        logoutAt: new Date(),
      })
      .where('user_id = :userId', { userId })
      .andWhere('is_active = true')
      .execute();
    return result.affected ?? 0;
  }

  private async findUser(
    userId: string,
    tenantScopeId?: string,
  ): Promise<User> {
    const user = await this.users.findOne({
      where: {
        userId,
        isDeleted: false,
        ...(tenantScopeId ? { tenant: { tenantId: tenantScopeId } } : {}),
      },
      relations: { tenant: true },
    });
    if (!user) {
      throw new NotFoundException(`User not found: ${userId}`);
    }
    return user;
  }

  private async resolveTenant(
    requestedTenantId: string | undefined,
    tenantScopeId?: string,
  ): Promise<Tenant | null> {
    if (tenantScopeId) {
      if (requestedTenantId && requestedTenantId !== tenantScopeId) {
        throw new ForbiddenException('Cannot create a user for another tenant');
      }
      const tenant = await this.tenants.findOne({
        where: { tenantId: tenantScopeId, isDeleted: false },
      });
      if (!tenant) {
        throw new NotFoundException('Tenant not found');
      }
      return tenant;
    }
    if (!requestedTenantId) {
      return null;
    }
    const tenant = await this.tenants.findOne({
      where: { tenantId: requestedTenantId, isDeleted: false },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }

  private async ensureMaxUsers(tenant: Tenant): Promise<void> {
    if (tenant.maxUsers == null) return;
    const count = await this.users.count({
      where: { tenant: { tenantId: tenant.tenantId }, isDeleted: false },
    });
    if (count >= tenant.maxUsers) {
      throw new ConflictException(
        `Tenant has reached the maximum of ${tenant.maxUsers} users`,
      );
    }
  }

  private async ensureUsernameAvailable(username: string): Promise<void> {
    if (
      await this.users.exists({
        where: { username, isDeleted: false },
      })
    ) {
      throw new ConflictException(`Username already taken: ${username}`);
    }
  }

  private async ensureEmailAvailable(
    email: string,
    excludeUserId?: string,
  ): Promise<void> {
    const existing = await this.users.findOne({
      where: { email, isDeleted: false },
    });
    if (existing && existing.userId !== excludeUserId) {
      throw new ConflictException(`Email already registered: ${email}`);
    }
  }

  private generateTempPassword(): string {
    const raw = randomBytes(9).toString('base64url');
    return `Tmp!${raw}9A`;
  }

  private displayName(user: User): string {
    return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  }

  private displayNameAr(user: User): string | null {
    const value = [user.firstNameAr, user.lastNameAr]
      .filter((part) => part?.trim())
      .join(' ')
      .trim();
    return value || null;
  }

  private async attachRoles(users: User[]): Promise<void> {
    const ids = users.map((user) => user.userId).filter(Boolean);
    if (ids.length === 0) return;
    const rows = await this.users.query<
      Array<{ user_id: string; role_code: string }>
    >(
      `SELECT DISTINCT ON (ur.user_id) ur.user_id, r.role_code
         FROM core.user_roles ur
         JOIN core.roles r ON r.role_id = ur.role_id
        WHERE ur.user_id = ANY($1)
          AND ur.is_deleted = false
          AND r.is_deleted = false
        ORDER BY ur.user_id, r.is_system_role DESC, r.role_code`,
      [ids],
    );
    const byUser = new Map(rows.map((row) => [row.user_id, row.role_code]));
    for (const user of users) {
      user.role = byUser.get(user.userId) ?? user.role ?? null;
    }
  }

  private async assignRole(userId: string, roleCode: string): Promise<void> {
    await this.users.query(
      `INSERT INTO core.user_roles (user_id, role_id)
       SELECT $1, r.role_id
         FROM core.roles r
        WHERE r.role_code = $2
          AND r.tenant_id IS NULL
          AND r.is_deleted = false
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [userId, roleCode],
    );
  }

  private toResponse(
    user: User,
    temporaryPassword?: string,
  ): UserResponseDto {
    return {
      userId: user.userId,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      firstNameAr: user.firstNameAr,
      lastNameAr: user.lastNameAr,
      fullName: this.displayName(user),
      fullNameAr: this.displayNameAr(user),
      role: toApiRole(user.role),
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      requirePasswordChange: user.requirePasswordChange,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      lastLoginIp: user.lastLoginIp,
      tenantId: user.tenant?.tenantId ?? null,
      tenantName: user.tenant?.tenantName ?? null,
      createdAt: user.createdAt?.toISOString() ?? null,
      updatedAt: user.updatedAt?.toISOString() ?? null,
      ...(temporaryPassword ? { temporaryPassword } : {}),
    };
  }

  private toActiveSessionResponse(
    session: RefreshSession,
  ): ActiveSessionResponseDto {
    const user = session.user;
    return {
      ...this.toSessionResponse(session),
      userId: user.userId,
      username: user.username,
      fullName:
        `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.username,
      tenantId: user.tenant?.tenantId ?? null,
      tenantName: user.tenant?.tenantName ?? null,
    };
  }

  private toSessionResponse(session: RefreshSession): UserSessionResponseDto {
    const now = Date.now();
    const notExpired = session.expiresAt.getTime() > now;
    return {
      sessionId: session.sessionId,
      loginAt: session.createdAt?.toISOString() ?? null,
      lastActivityAt: session.lastActivityAt?.toISOString() ?? null,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      expiresAt: session.expiresAt?.toISOString() ?? null,
      isActive: session.isActive && !session.isRevoked && notExpired,
      isRevoked: session.isRevoked,
    };
  }

  private async writeAudit(
    user: User,
    actorUserId: string,
    actionType: string,
  ): Promise<void> {
    await this.auditLogs.save(
      this.auditLogs.create({
        tenantId: user.tenant?.tenantId ?? null,
        userId: actorUserId,
        actionType,
        entityType: 'USER',
        entityId: user.userId,
        entityName: user.username,
        ipAddress: null,
        userAgent: null,
        success: true,
        errorMessage: null,
      }),
    );
  }

  private parseStatus(raw?: string): UserStatus | undefined {
    if (raw === undefined || raw === '') return undefined;
    if (!Object.values(UserStatus).includes(raw as UserStatus)) {
      throw new BadRequestException("Invalid value for parameter 'status'");
    }
    return raw as UserStatus;
  }

  private parseSort(raw?: string): [string, 'ASC' | 'DESC'] {
    if (!raw?.trim()) return [SORT_FIELDS.username, 'ASC'];
    const [field, direction] = raw.split(':').map((part) => part.trim());
    if (!SORT_FIELDS[field]) return [SORT_FIELDS.username, 'ASC'];
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
}
