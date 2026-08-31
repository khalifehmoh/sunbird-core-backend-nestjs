import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant } from '../database/entities/tenant.entity';
import {
  PagedResponseDto,
  TenantRequestDto,
  TenantResponseDto,
} from './dto/tenant.dto';
import { TenantStatus } from './tenant-status.enum';

const ORGANIZATION_TYPES = new Set([
  'HOSPITAL',
  'NETWORK',
  'CLINIC',
  'LAB',
  'PHARMACY',
]);

const SORT_FIELDS: Record<string, keyof Tenant> = {
  tenantCode: 'tenantCode',
  tenantName: 'tenantName',
  tenantNameAr: 'tenantNameAr',
  status: 'status',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  maxUsers: 'maxUsers',
  organizationType: 'organizationType',
  licenseNumber: 'licenseNumber',
};

export type TenantListQuery = {
  page?: string;
  size?: string;
  sort?: string;
  search?: string;
  status?: string;
  type?: string;
};

@Injectable()
export class TenantsService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
  ) {}

  async findAll(): Promise<TenantResponseDto[]> {
    const tenants = await this.tenants.find({
      where: { isDeleted: false },
      order: { createdAt: 'DESC' },
    });
    return tenants.map((tenant) => this.toResponse(tenant));
  }

  async findPaged(
    query: TenantListQuery,
  ): Promise<PagedResponseDto<TenantResponseDto>> {
    const page = this.parseNonNegativeInt(query.page, 0, 'page');
    const size = this.parseNonNegativeInt(query.size, 20, 'size');
    const status = this.parseStatus(query.status);
    const organizationType = this.normalizeOrganizationType(query.type);
    const [sortField, sortDirection] = this.parseSort(query.sort);

    const builder = this.tenants
      .createQueryBuilder('tenant')
      .where('tenant.is_deleted = false');
    if (status) {
      builder.andWhere('tenant.status = :status', { status });
    }
    if (organizationType) {
      builder.andWhere('tenant.organization_type = :organizationType', {
        organizationType,
      });
    }
    const search = query.search?.trim();
    if (search) {
      builder.andWhere(
        `(LOWER(tenant.tenant_code) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(tenant.tenant_name) LIKE :search ESCAPE '\\' OR ` +
          `LOWER(COALESCE(tenant.tenant_name_ar, '')) LIKE :search ESCAPE '\\')`,
        { search: `%${this.escapeLike(search.toLowerCase())}%` },
      );
    }

    const [content, totalElements] = await builder
      .orderBy(`tenant.${sortField}`, sortDirection)
      .skip(page * size)
      .take(size)
      .getManyAndCount();
    const totalPages = size === 0 ? 1 : Math.ceil(totalElements / size);
    return {
      content: content.map((tenant) => this.toResponse(tenant)),
      page,
      size,
      totalElements,
      totalPages,
      last: totalPages === 0 || page >= totalPages - 1,
    };
  }

  async findOne(id: string): Promise<TenantResponseDto> {
    const tenant = await this.tenants.findOne({
      where: { tenantId: id, isDeleted: false },
    });
    if (!tenant) {
      throw new NotFoundException(`Tenant not found: ${id}`);
    }
    return this.toResponse(tenant);
  }

  async create(request: TenantRequestDto): Promise<TenantResponseDto> {
    if (
      await this.tenants.exists({
        where: { tenantCode: request.tenantCode, isDeleted: false },
      })
    ) {
      throw new ConflictException('Tenant code already exists');
    }
    const tenant = this.tenants.create({
      tenantCode: request.tenantCode,
      tenantName: request.tenantName,
      tenantNameAr: request.tenantNameAr ?? null,
      organizationType: request.organizationType ?? null,
      licenseNumber: request.licenseNumber ?? null,
      maxUsers: request.maxUsers,
      status: TenantStatus.ACTIVE,
      isDeleted: false,
    });
    return this.toResponse(await this.tenants.save(tenant));
  }

  async update(
    id: string,
    request: TenantRequestDto,
  ): Promise<TenantResponseDto> {
    const tenant = await this.tenants.findOne({
      where: { tenantId: id, isDeleted: false },
    });
    if (!tenant) {
      throw new NotFoundException('Not found');
    }
    Object.assign(tenant, {
      tenantCode: request.tenantCode ?? tenant.tenantCode,
      tenantName: request.tenantName ?? tenant.tenantName,
      tenantNameAr: request.tenantNameAr ?? tenant.tenantNameAr,
      organizationType: request.organizationType ?? tenant.organizationType,
      licenseNumber: request.licenseNumber ?? tenant.licenseNumber,
      maxUsers: request.maxUsers ?? tenant.maxUsers,
    });
    return this.toResponse(await this.tenants.save(tenant));
  }

  async updateStatus(
    id: string,
    status: TenantStatus,
  ): Promise<TenantResponseDto> {
    const tenant = await this.tenants.findOne({
      where: { tenantId: id, isDeleted: false },
    });
    if (!tenant) {
      throw new NotFoundException(`Tenant not found: ${id}`);
    }
    tenant.status = status;
    return this.toResponse(await this.tenants.save(tenant));
  }

  async delete(id: string): Promise<void> {
    const tenant = await this.tenants.findOne({ where: { tenantId: id } });
    if (!tenant) {
      throw new NotFoundException('Not found');
    }
    tenant.isDeleted = true;
    await this.tenants.save(tenant);
  }

  private toResponse(tenant: Tenant): TenantResponseDto {
    return {
      tenantId: tenant.tenantId,
      tenantCode: tenant.tenantCode,
      tenantName: tenant.tenantName,
      tenantNameAr: tenant.tenantNameAr,
      organizationType: tenant.organizationType,
      licenseNumber: tenant.licenseNumber,
      status: tenant.status,
      maxUsers: tenant.maxUsers,
      createdAt: tenant.createdAt?.toISOString().replace('Z', '') ?? null,
      updatedAt: tenant.updatedAt?.toISOString().replace('Z', '') ?? null,
    };
  }

  private normalizeOrganizationType(raw?: string): string | undefined {
    if (!raw?.trim()) return undefined;
    const normalized = raw.trim().toUpperCase();
    if (!ORGANIZATION_TYPES.has(normalized)) {
      throw new BadRequestException(
        'Invalid type; allowed values: HOSPITAL, NETWORK, CLINIC, LAB, PHARMACY',
      );
    }
    return normalized;
  }

  private parseStatus(raw?: string): TenantStatus | undefined {
    if (raw === undefined) return undefined;
    if (!Object.values(TenantStatus).includes(raw as TenantStatus)) {
      throw new BadRequestException("Invalid value for parameter 'status'");
    }
    return raw as TenantStatus;
  }

  private parseSort(raw?: string): [keyof Tenant, 'ASC' | 'DESC'] {
    if (!raw?.trim()) return ['createdAt', 'DESC'];
    const [field, direction] = raw.split(':').map((part) => part.trim());
    if (!SORT_FIELDS[field]) return ['createdAt', 'DESC'];
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
