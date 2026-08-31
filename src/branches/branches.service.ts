import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Branch } from '../database/entities/branch.entity';
import { BranchResponseDto, PagedResponseDto } from './dto/branch.dto';
import { Repository } from 'typeorm';
import { BranchStatus } from './branch-status.enum';
import { BranchType } from './branch-type.enum';
import { AuditLog } from '../database/entities/audit-log.entity';
import { Tenant } from '../database/entities/tenant.entity';
import { BranchRequestDto } from './dto/branch.dto';

export type BranchListQuery = {
  page?: string;
  size?: string;
  sort?: string;
  search?: string;
  status?: string;
  type?: string;
  tenantId?: string;
  hqOnly?: string;
  'hq-only'?: string;
};

const SORT_FIELDS: Record<string, string> = {
  branchCode: 'branch.branch_code',
  branchName: 'branch.branch_name',
  branchType: 'branch.branch_type',
  tenant: 'tenant.tenant_name',
  tenantName: 'tenant.tenant_name',
  city: 'branch.city',
  status: 'branch.status',
};

@Injectable()
export class BranchesService {
  constructor(
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async findAll(tenantId?: string): Promise<BranchResponseDto[]> {
    const branches = await this.branches.find({
      where: {
        isDeleted: false,
        ...(tenantId ? { tenant: { tenantId } } : {}),
      },
      relations: { tenant: true },
      order: { createdAt: 'DESC' },
    });
    return branches.map((branch) => this.toResponse(branch));
  }

  async findPaged(
    tenantScopeId: string | undefined,
    query: BranchListQuery,
  ): Promise<PagedResponseDto<BranchResponseDto>> {
    const page = this.parseNonNegativeInt(query.page, 0, 'page');
    const size = this.parseNonNegativeInt(query.size, 20, 'size');
    const status = this.parseStatus(query.status);
    const type = this.parseBranchType(query.type);
    const isHeadquarters =
      query.hqOnly === 'true' || query['hq-only'] === 'true';
    const [sortField, sortDirection] = this.parseSort(query.sort);

    const builder = this.branches
      .createQueryBuilder('branch')
      .leftJoinAndSelect('branch.tenant', 'tenant')
      .where('branch.is_deleted = false');
    const tenantId = tenantScopeId ?? query.tenantId;
    if (tenantId) {
      builder.andWhere('branch.tenant_id = :tenantId', { tenantId });
    }
    if (status) {
      builder.andWhere('branch.status = :status', { status });
    }
    if (type) {
      builder.andWhere('branch.branch_type = :type', { type });
    }
    if (isHeadquarters) {
      builder.andWhere('branch.is_headquarters = :isHeadquarters', {
        isHeadquarters,
      });
    }
    const search = query.search?.trim();
    if (search) {
      builder.andWhere(
        `(LOWER(branch.branch_code) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(branch.branch_name) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(COALESCE(branch.branch_name_ar, '')) LIKE :search ESCAPE '\\')`,
        { search: `%${this.escapeLike(search.toLowerCase())}%` },
      );
    }

    const [content, totalElements] = await builder
      .orderBy(sortField, sortDirection)
      .skip(page * size)
      .take(size)
      .getManyAndCount();
    const totalPages = size === 0 ? 1 : Math.ceil(totalElements / size);
    return {
      content: content.map((branch) => this.toResponse(branch)),
      page,
      size,
      totalElements,
      totalPages,
      last: totalPages === 0 || page >= totalPages - 1,
    };
  }

  async findOne(
    branchId: string,
    tenantScopeId?: string,
  ): Promise<BranchResponseDto> {
    return this.toResponse(await this.findBranch(branchId, tenantScopeId));
  }

  async create(
    request: BranchRequestDto,
    tenantScopeId: string | undefined,
    userId: string,
  ): Promise<BranchResponseDto> {
    const tenant = await this.resolveTenant(request.tenantId, tenantScopeId);
    const branchCode = request.branchCode.trim().toUpperCase();
    await this.ensureCodeAvailable(tenant.tenantId, branchCode);
    await this.ensureBranchLimit(tenant);
    if (request.isHeadquarters) {
      await this.ensureHeadquartersAvailable(tenant.tenantId);
    }

    const branch = this.branches.create({
      tenant,
      branchCode,
      branchName: request.branchName.trim(),
      branchNameAr: request.branchNameAr?.trim() || null,
      branchType: request.branchType,
      isHeadquarters: request.isHeadquarters ?? false,
      licenseNumber: request.licenseNumber?.trim() || null,
      contactEmail: request.contactEmail?.trim() || null,
      contactPhone: request.contactPhone?.trim() || null,
      address: request.address?.trim() || null,
      city: request.city?.trim() || null,
      region: request.region?.trim() || null,
      status: BranchStatus.ACTIVE,
      isDeleted: false,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.branches.save(branch);
    await this.writeAudit(saved, userId, 'CREATE');
    return this.toResponse(saved);
  }

  async update(
    branchId: string,
    request: BranchRequestDto,
    tenantScopeId: string | undefined,
    userId: string,
  ): Promise<BranchResponseDto> {
    const branch = await this.findBranch(branchId, tenantScopeId);
    if (request.tenantId !== branch.tenant.tenantId) {
      throw new BadRequestException(
        'A branch cannot be moved to another tenant',
      );
    }
    if (request.isHeadquarters && !branch.isHeadquarters) {
      await this.ensureHeadquartersAvailable(branch.tenant.tenantId, branchId);
    }

    Object.assign(branch, {
      branchName: request.branchName.trim(),
      branchNameAr: request.branchNameAr?.trim() || null,
      branchType: request.branchType,
      isHeadquarters: request.isHeadquarters ?? false,
      city: request.city?.trim() || null,
      status: request.status ?? branch.status,
      updatedBy: userId,
      ...(request.licenseNumber !== undefined
        ? { licenseNumber: request.licenseNumber.trim() || null }
        : {}),
      ...(request.contactEmail !== undefined
        ? { contactEmail: request.contactEmail.trim() || null }
        : {}),
      ...(request.contactPhone !== undefined
        ? { contactPhone: request.contactPhone.trim() || null }
        : {}),
      ...(request.address !== undefined
        ? { address: request.address.trim() || null }
        : {}),
      ...(request.region !== undefined
        ? { region: request.region.trim() || null }
        : {}),
    });
    const saved = await this.branches.save(branch);
    await this.writeAudit(saved, userId, 'UPDATE');
    return this.toResponse(saved);
  }

  async updateStatus(
    branchId: string,
    status: BranchStatus,
    tenantScopeId: string | undefined,
    userId: string,
  ): Promise<BranchResponseDto> {
    const branch = await this.findBranch(branchId, tenantScopeId);
    branch.status = status;
    branch.updatedBy = userId;
    const saved = await this.branches.save(branch);
    await this.writeAudit(saved, userId, 'UPDATE');
    return this.toResponse(saved);
  }

  async delete(
    branchId: string,
    tenantScopeId: string | undefined,
    userId: string,
  ): Promise<void> {
    const branch = await this.findBranch(branchId, tenantScopeId);
    if (branch.isHeadquarters) {
      const otherBranches = await this.branches
        .createQueryBuilder('branch')
        .where('branch.tenant_id = :tenantId', {
          tenantId: branch.tenant.tenantId,
        })
        .andWhere('branch.branch_id <> :branchId', { branchId })
        .andWhere('branch.is_deleted = false')
        .getCount();
      if (otherBranches > 0) {
        throw new ConflictException(
          'Cannot delete the headquarters branch while other branches exist',
        );
      }
    }

    branch.isDeleted = true;
    branch.deletedAt = new Date();
    branch.deletedBy = userId;
    branch.updatedBy = userId;
    await this.branches.save(branch);
    await this.writeAudit(branch, userId, 'DELETE');
  }

  private parseStatus(raw?: string): BranchStatus | undefined {
    if (raw === undefined) return undefined;
    if (!Object.values(BranchStatus).includes(raw as BranchStatus)) {
      throw new BadRequestException("Invalid value for parameter 'status'");
    }
    return raw as BranchStatus;
  }

  private parseBranchType(raw?: string): BranchType | undefined {
    if (raw === undefined) return undefined;
    if (!Object.values(BranchType).includes(raw as BranchType)) {
      throw new BadRequestException("Invalid value for parameter 'type'");
    }
    return raw as BranchType;
  }

  private parseSort(raw?: string): [string, 'ASC' | 'DESC'] {
    if (!raw?.trim()) return [SORT_FIELDS.branchCode, 'ASC'];
    const [field, direction] = raw.split(':').map((part) => part.trim());
    if (!SORT_FIELDS[field]) return [SORT_FIELDS.branchCode, 'ASC'];
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
    return raw.replace(/[%_\\]/g, '\\$1');
  }

  private async findBranch(
    branchId: string,
    tenantScopeId?: string,
  ): Promise<Branch> {
    const branch = await this.branches.findOne({
      where: {
        branchId,
        isDeleted: false,
        ...(tenantScopeId ? { tenant: { tenantId: tenantScopeId } } : {}),
      },
      relations: { tenant: true },
    });
    if (!branch) {
      throw new NotFoundException('Branch not found');
    }
    return branch;
  }

  private async resolveTenant(
    requestedTenantId: string,
    tenantScopeId?: string,
  ): Promise<Tenant> {
    if (tenantScopeId && tenantScopeId !== requestedTenantId) {
      throw new ForbiddenException('Cannot create a branch for another tenant');
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
    branchCode: string,
  ): Promise<void> {
    if (
      await this.branches.exists({
        where: { tenant: { tenantId }, branchCode },
      })
    ) {
      throw new ConflictException('Branch code already exists for this tenant');
    }
  }

  private async ensureBranchLimit(tenant: Tenant): Promise<void> {
    const currentCount = await this.branches.count({
      where: { tenant: { tenantId: tenant.tenantId }, isDeleted: false },
    });
    if (tenant.maxBranches !== null && currentCount >= tenant.maxBranches) {
      throw new ConflictException(
        `Tenant branch limit of ${tenant.maxBranches} has been reached`,
      );
    }
  }

  private async ensureHeadquartersAvailable(
    tenantId: string,
    excludeBranchId?: string,
  ): Promise<void> {
    const builder = this.branches
      .createQueryBuilder('branch')
      .where('branch.tenant_id = :tenantId', { tenantId })
      .andWhere('branch.is_headquarters = true')
      .andWhere('branch.is_deleted = false');
    if (excludeBranchId) {
      builder.andWhere('branch.branch_id <> :excludeBranchId', {
        excludeBranchId,
      });
    }
    if ((await builder.getCount()) > 0) {
      throw new ConflictException(
        'Only one headquarters branch is allowed per tenant',
      );
    }
  }

  private async writeAudit(
    branch: Branch,
    userId: string,
    actionType: 'CREATE' | 'UPDATE' | 'DELETE',
  ): Promise<void> {
    await this.auditLogs.save(
      this.auditLogs.create({
        tenantId: branch.tenant.tenantId,
        userId,
        actionType,
        entityType: 'BRANCH',
        entityId: branch.branchId,
        entityName: branch.branchName,
        ipAddress: null,
        userAgent: null,
        success: true,
        errorMessage: null,
      }),
    );
  }

  private toResponse(branch: Branch): BranchResponseDto {
    return {
      branchId: branch.branchId,
      branchCode: branch.branchCode,
      branchName: branch.branchName,
      branchNameAr: branch.branchNameAr,
      branchType: branch.branchType,
      isHeadquarters: branch.isHeadquarters,
      licenseNumber: branch.licenseNumber,
      contactEmail: branch.contactEmail,
      contactPhone: branch.contactPhone,
      address: branch.address,
      city: branch.city,
      region: branch.region,
      status: branch.status,
      tenantId: branch.tenant.tenantId,
      tenantName: branch.tenant.tenantName,
      createdAt: branch.createdAt?.toISOString() ?? null,
      updatedAt: branch.updatedAt?.toISOString() ?? null,
    };
  }
}
