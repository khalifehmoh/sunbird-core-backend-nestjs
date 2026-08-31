import { BadRequestException, ConflictException } from '@nestjs/common';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Tenant } from '../database/entities/tenant.entity';
import { TenantStatus } from './tenant-status.enum';
import { TenantsService } from './tenants.service';

describe('TenantsService', () => {
  let repository: jest.Mocked<Repository<Tenant>>;
  let queryBuilder: jest.Mocked<SelectQueryBuilder<Tenant>>;
  let service: TenantsService;

  beforeEach(() => {
    repository = {
      find: jest.fn(),
      findOne: jest.fn(),
      exists: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    } as unknown as jest.Mocked<Repository<Tenant>>;
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
    } as unknown as jest.Mocked<SelectQueryBuilder<Tenant>>;
    repository.createQueryBuilder.mockReturnValue(queryBuilder);
    service = new TenantsService(repository);
  });

  it('returns active tenants in repository order', async () => {
    const tenant = entity();
    repository.find.mockResolvedValue([tenant]);

    const result = await service.findAll();

    expect(repository.find.mock.calls[0][0]).toEqual({
      where: { isDeleted: false },
      order: { createdAt: 'DESC' },
    });
    expect(result[0].tenantCode).toBe('SUN');
  });

  it('rejects an unsupported organization type before querying', async () => {
    await expect(service.findPaged({ type: 'school' })).rejects.toThrow(
      new BadRequestException(
        'Invalid type; allowed values: HOSPITAL, NETWORK, CLINIC, LAB, PHARMACY',
      ),
    );
  });

  it('rejects an invalid tenant status', async () => {
    await expect(service.findPaged({ status: 'DELETED' })).rejects.toThrow(
      "Invalid value for parameter 'status'",
    );
  });

  it('builds a filtered paged response with Spring-compatible metadata', async () => {
    queryBuilder.getManyAndCount.mockResolvedValue([[entity()], 21]);

    const response = await service.findPaged({
      page: '1',
      size: '20',
      sort: 'tenantName:asc',
      search: 'SUN%_',
      status: 'ACTIVE',
      type: 'hospital',
    });

    expect(response).toMatchObject({
      page: 1,
      size: 20,
      totalElements: 21,
      totalPages: 2,
      last: true,
    });
    expect(queryBuilder.orderBy.mock.calls[0]).toEqual([
      'tenant.tenantName',
      'ASC',
    ]);
    expect(queryBuilder.andWhere.mock.calls).toHaveLength(3);
  });

  it('falls back to createdAt descending for unsupported sort fields', async () => {
    queryBuilder.getManyAndCount.mockResolvedValue([[], 0]);
    await service.findPaged({ sort: 'passwordHash:asc' });
    expect(queryBuilder.orderBy.mock.calls[0]).toEqual([
      'tenant.createdAt',
      'DESC',
    ]);
  });

  it('prevents duplicate active tenant codes', async () => {
    repository.exists.mockResolvedValue(true);
    await expect(
      service.create({
        tenantCode: 'SUN',
        tenantName: 'Sunbird',
        maxUsers: 50,
      }),
    ).rejects.toThrow(new ConflictException('Tenant code already exists'));
  });

  it('soft deletes a tenant', async () => {
    const tenant = entity();
    repository.findOne.mockResolvedValue(tenant);
    repository.save.mockResolvedValue(tenant);

    await service.delete(tenant.tenantId);

    expect(tenant.isDeleted).toBe(true);
    expect(repository.save.mock.calls[0][0]).toBe(tenant);
  });

  it('does not return a soft-deleted tenant by id', async () => {
    repository.findOne.mockResolvedValue(null);
    await expect(service.findOne(entity().tenantId)).rejects.toThrow(
      `Tenant not found: ${entity().tenantId}`,
    );
  });

  it('updates tenant status for an active tenant', async () => {
    const tenant = entity();
    repository.findOne.mockResolvedValue(tenant);
    repository.save.mockImplementation(async (value) => value as Tenant);

    const result = await service.updateStatus(
      tenant.tenantId,
      TenantStatus.SUSPENDED,
    );

    expect(tenant.status).toBe(TenantStatus.SUSPENDED);
    expect(result.status).toBe(TenantStatus.SUSPENDED);
    expect(repository.findOne.mock.calls[0][0]).toEqual({
      where: { tenantId: tenant.tenantId, isDeleted: false },
    });
  });

  function entity(): Tenant {
    return {
      tenantId: '6e8c4164-356b-46e7-99d2-137449b84b59',
      tenantCode: 'SUN',
      tenantName: 'Sunbird',
      tenantNameAr: null,
      organizationType: 'HOSPITAL',
      licenseNumber: null,
      status: TenantStatus.ACTIVE,
      maxUsers: 50,
      maxBranches: 10,
      isDeleted: false,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      users: [],
    };
  }
});
