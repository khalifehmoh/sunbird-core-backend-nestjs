import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { UserStatus } from '../auth/user-status.enum';
import { AuditLog } from '../database/entities/audit-log.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { User } from '../database/entities/user.entity';
import {
  AuditLogResponseDto,
  FailedLoginSummaryDto,
  PagedResponseDto,
} from './dto/audit.dto';

export type AuditListQuery = {
  page?: string;
  size?: string;
  limit?: string;
  sort?: string;
  search?: string;
  from?: string;
  to?: string;
  userId?: string;
  actionType?: string;
  entity?: string;
  entityType?: string;
  tenantId?: string;
  ip?: string;
};

const ACTION_TYPES = new Set([
  'LOGIN',
  'LOGOUT',
  'FAILED_LOGIN',
  'CREATE',
  'READ',
  'UPDATE',
  'DELETE',
  'ASSIGN_ROLE',
  'REVOKE_ROLE',
  'GRANT_PERMISSION',
  'REVOKE_PERMISSION',
  'ACTIVATE',
  'DEACTIVATE',
  'LOCK',
  'UNLOCK',
]);

const ENTITY_TYPES = new Set([
  'TENANT',
  'BRANCH',
  'USER',
  'GROUP',
  'ROLE',
  'PERMISSION',
  'MODULE',
  'CONFIG',
]);

const SORT_FIELDS: Record<string, string> = {
  createdAt: 'audit.created_at',
  created_at: 'audit.created_at',
  actionType: 'audit.action_type',
  entityType: 'audit.entity_type',
  success: 'audit.success',
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EXPORT_ROW_CAP = 10_000;

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
  ) {}

  async findPaged(
    tenantScopeId: string | undefined,
    query: AuditListQuery,
    options?: { includeValues?: boolean },
  ): Promise<PagedResponseDto<AuditLogResponseDto>> {
    const page = this.parseNonNegativeInt(query.page, 0, 'page');
    const size = this.parseNonNegativeInt(
      query.size ?? query.limit,
      20,
      'size',
    );
    const [sortField, sortDirection] = this.parseSort(query.sort);

    const builder = this.filteredBuilder(tenantScopeId, query);
    const [content, totalElements] = await builder
      .orderBy(sortField, sortDirection)
      .skip(page * size)
      .take(size)
      .getManyAndCount();

    const totalPages = size === 0 ? 1 : Math.ceil(totalElements / size);
    return {
      content: await this.toResponses(content, options?.includeValues ?? false),
      page,
      size,
      totalElements,
      totalPages,
      last: totalPages === 0 || page >= totalPages - 1,
    };
  }

  async findOne(
    auditId: string,
    tenantScopeId?: string,
  ): Promise<AuditLogResponseDto> {
    const builder = this.auditLogs
      .createQueryBuilder('audit')
      .where('audit.audit_id = :auditId', { auditId });
    if (tenantScopeId) {
      builder.andWhere('audit.tenant_id = :tenantScopeId', { tenantScopeId });
    }
    const audit = await builder.getOne();
    if (!audit) {
      throw new NotFoundException('Audit event not found');
    }
    const [dto] = await this.toResponses([audit], true);
    return dto;
  }

  async exportCsv(
    tenantScopeId: string | undefined,
    query: AuditListQuery,
  ): Promise<string> {
    const builder = this.filteredBuilder(tenantScopeId, query);
    const [sortField, sortDirection] = this.parseSort(query.sort);
    const rows = await builder
      .orderBy(sortField, sortDirection)
      .take(EXPORT_ROW_CAP)
      .getMany();
    const dtos = await this.toResponses(rows, false);
    const header = [
      'Timestamp',
      'Username',
      'Action',
      'Entity Type',
      'Entity Name',
      'IP Address',
      'Result',
      'Error',
    ];
    const lines = [
      header.join(','),
      ...dtos.map((row) =>
        [
          row.createdAt,
          row.username,
          row.actionType,
          row.entityType,
          row.entityName,
          row.ipAddress,
          row.success ? 'SUCCESS' : 'FAILED',
          row.errorMessage,
        ]
          .map((value) => this.csvEscape(value))
          .join(','),
      ),
    ];
    return lines.join('\n');
  }

  async failedLoginSummary(
    tenantScopeId: string | undefined,
    query: Pick<AuditListQuery, 'from' | 'to'>,
  ): Promise<FailedLoginSummaryDto> {
    const range = this.defaultFailedLoginRange(query.from, query.to);
    const builder = this.filteredBuilder(tenantScopeId, {
      actionType: 'FAILED_LOGIN',
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    });

    const [totalFailed, uniqueIpRows, flaggedRows] = await Promise.all([
      builder.clone().getCount(),
      builder
        .clone()
        .select('COUNT(DISTINCT audit.ip_address)', 'count')
        .andWhere('audit.ip_address IS NOT NULL')
        .getRawOne<{ count: string }>(),
      builder
        .clone()
        .select('audit.ip_address', 'ip')
        .addSelect('COUNT(*)', 'attempts')
        .andWhere('audit.ip_address IS NOT NULL')
        .groupBy('audit.ip_address')
        .having('COUNT(*) > 5')
        .getRawMany<{ ip: string; attempts: string }>(),
    ]);

    const lockedBuilder = this.users
      .createQueryBuilder('user')
      .where('user.is_deleted = false')
      .andWhere(
        '(user.account_locked_until IS NOT NULL AND user.account_locked_until > :now) OR user.status = :locked',
        { now: new Date(), locked: UserStatus.LOCKED },
      );
    if (tenantScopeId) {
      lockedBuilder.andWhere('user.tenant_id = :tenantScopeId', {
        tenantScopeId,
      });
    }

    return {
      totalFailed,
      uniqueIps: Number(uniqueIpRows?.count ?? 0),
      lockedAccounts: await lockedBuilder.getCount(),
      flaggedIps: flaggedRows.map((row) => row.ip).filter(Boolean),
    };
  }

  private filteredBuilder(
    tenantScopeId: string | undefined,
    query: AuditListQuery,
  ): SelectQueryBuilder<AuditLog> {
    const builder = this.auditLogs
      .createQueryBuilder('audit')
      .leftJoin(User, 'actor', 'actor.user_id = audit.user_id');
    const tenantId = tenantScopeId ?? this.parseOptionalUuid(query.tenantId, 'tenantId');
    if (tenantId) {
      builder.andWhere('audit.tenant_id = :tenantId', { tenantId });
    }

    const from = this.parseDate(query.from, 'from', 'start');
    if (from) {
      builder.andWhere('audit.created_at >= :from', { from });
    }
    const to = this.parseDate(query.to, 'to', 'end');
    if (to) {
      builder.andWhere('audit.created_at <= :to', { to });
    }

    const userId = this.parseOptionalUuid(query.userId, 'userId');
    if (userId) {
      builder.andWhere('audit.user_id = :userId', { userId });
    }

    const actionType = this.parseActionType(query.actionType);
    if (actionType) {
      builder.andWhere('audit.action_type = :actionType', { actionType });
    }

    const entityType = this.parseEntityType(query.entityType ?? query.entity);
    if (entityType) {
      builder.andWhere('audit.entity_type = :entityType', { entityType });
    }

    if (query.ip?.trim()) {
      builder.andWhere('audit.ip_address = :ip', { ip: query.ip.trim() });
    }

    const search = query.search?.trim();
    if (search) {
      builder.andWhere(
        `(LOWER(COALESCE(actor.username, '')) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(COALESCE(audit.entity_name, '')) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(COALESCE(audit.ip_address, '')) LIKE :search ESCAPE '\\')`,
        { search: `%${this.escapeLike(search.toLowerCase())}%` },
      );
    }

    return builder;
  }

  private async toResponses(
    logs: AuditLog[],
    includeValues: boolean,
  ): Promise<AuditLogResponseDto[]> {
    if (logs.length === 0) return [];

    const actorIds = [
      ...new Set(logs.map((log) => log.userId).filter((id): id is string => !!id)),
    ];
    const targetIds = [
      ...new Set(
        logs
          .filter((log) => log.entityType === 'USER' && log.entityId)
          .map((log) => log.entityId as string),
      ),
    ];
    const tenantIds = [
      ...new Set(
        logs.map((log) => log.tenantId).filter((id): id is string => !!id),
      ),
    ];

    const [actors, targets, tenants] = await Promise.all([
      actorIds.length
        ? this.users.find({ where: { userId: In(actorIds) } })
        : Promise.resolve([] as User[]),
      targetIds.length
        ? this.users.find({ where: { userId: In(targetIds) } })
        : Promise.resolve([] as User[]),
      tenantIds.length
        ? this.tenants.find({ where: { tenantId: In(tenantIds) } })
        : Promise.resolve([] as Tenant[]),
    ]);
    const actorMap = new Map(actors.map((user) => [user.userId, user]));
    const targetMap = new Map(targets.map((user) => [user.userId, user]));
    const tenantMap = new Map(tenants.map((tenant) => [tenant.tenantId, tenant]));

    return logs.map((log) => {
      const actor = log.userId ? actorMap.get(log.userId) : undefined;
      const target =
        log.entityType === 'USER' && log.entityId
          ? targetMap.get(log.entityId)
          : undefined;
      const tenant = log.tenantId ? tenantMap.get(log.tenantId) : undefined;
      return {
        auditId: log.auditId,
        createdAt: log.createdAt?.toISOString() ?? '',
        userId: log.userId,
        username: actor?.username ?? null,
        userFullName: actor
          ? `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() ||
            actor.username
          : null,
        actionType: log.actionType,
        entityType: log.entityType,
        entityId: log.entityId,
        entityName: log.entityName,
        tenantId: log.tenantId,
        tenantName: tenant?.tenantName ?? null,
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        success: log.success,
        errorMessage: log.errorMessage,
        oldValue: includeValues ? log.oldValue : null,
        newValue: includeValues ? log.newValue : null,
        failedLoginAttempts: target?.failedLoginAttempts ?? null,
        accountLockedUntil: target?.accountLockedUntil?.toISOString() ?? null,
        targetUserStatus: target?.status ?? null,
      };
    });
  }

  private defaultFailedLoginRange(
    fromRaw?: string,
    toRaw?: string,
  ): { from: Date; to: Date } {
    const to = this.parseDate(toRaw, 'to', 'end') ?? new Date();
    const from =
      this.parseDate(fromRaw, 'from', 'start') ??
      new Date(to.getTime() - 24 * 60 * 60 * 1000);
    return { from, to };
  }

  private parseActionType(raw?: string): string | undefined {
    if (!raw?.trim()) return undefined;
    const value = raw.trim().toUpperCase();
    if (!ACTION_TYPES.has(value)) {
      throw new BadRequestException("Invalid value for parameter 'actionType'");
    }
    return value;
  }

  private parseEntityType(raw?: string): string | undefined {
    if (!raw?.trim()) return undefined;
    const value = raw.trim().toUpperCase();
    if (!ENTITY_TYPES.has(value)) {
      throw new BadRequestException("Invalid value for parameter 'entity'");
    }
    return value;
  }

  private parseOptionalUuid(
    raw: string | undefined,
    name: string,
  ): string | undefined {
    if (!raw?.trim()) return undefined;
    if (!UUID_RE.test(raw)) {
      throw new BadRequestException(`Invalid value for parameter '${name}'`);
    }
    return raw;
  }

  private parseDate(
    raw: string | undefined,
    name: string,
    bound: 'start' | 'end',
  ): Date | undefined {
    if (!raw?.trim()) return undefined;
    const value = raw.trim();
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(
          bound === 'start' ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`,
        )
      : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid value for parameter '${name}'`);
    }
    return parsed;
  }

  private parseSort(raw?: string): [string, 'ASC' | 'DESC'] {
    if (!raw?.trim()) return [SORT_FIELDS.createdAt, 'DESC'];
    const [field, direction] = raw.split(':').map((part) => part.trim());
    if (!SORT_FIELDS[field]) return [SORT_FIELDS.createdAt, 'DESC'];
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

  private csvEscape(value: string | null | undefined): string {
    const text = value ?? '';
    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }
}
