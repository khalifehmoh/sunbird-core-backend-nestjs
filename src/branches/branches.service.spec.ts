import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Branch } from '../database/entities/branch.entity';
import { BranchStatus } from './branch-status.enum';
import { BranchesService } from './branches.service';
import { AuditLog } from '../database/entities/audit-log.entity';
import { ConflictException } from '@nestjs/common';
import { Tenant } from '../database/entities/tenant.entity';
import { BranchType } from './branch-type.enum';
import { TenantStatus } from '../tenants/tenant-status.enum';

describe('BranchesService', () => {
  let service: BranchesService;
  let repository: jest.Mocked<
    Pick<
      Repository<Branch>,
      | 'find'
      | 'findOne'
      | 'save'
      | 'create'
      | 'exists'
      | 'count'
      | 'createQueryBuilder'
    >
  >;
  let auditLogs: jest.Mocked<Pick<Repository<AuditLog>, 'create' | 'save'>>;
  let tenants: jest.Mocked<Pick<Repository<Tenant>, 'findOne'>>;

  beforeEach(async () => {
    repository = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      exists: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    auditLogs = {
      create: jest.fn((value) => value as AuditLog),
      save: jest.fn(),
    };
    tenants = {
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BranchesService,
        {
          provide: getRepositoryToken(Branch),
          useValue: repository,
        },
        {
          provide: getRepositoryToken(AuditLog),
          useValue: auditLogs,
        },
        {
          provide: getRepositoryToken(Tenant),
          useValue: tenants,
        },
      ],
    }).compile();

    service = module.get<BranchesService>(BranchesService);
  });

  it('returns non-deleted branches belonging to the current tenant', async () => {
    const tenantId = '6e8c4164-356b-46e7-99d2-137449b84b59';
    repository.find.mockResolvedValue([
      {
        branchId: '220e2fd1-5400-4f13-932c-0c8e9570380a',
        branchCode: 'RIYADH',
        branchName: 'Riyadh',
        branchNameAr: null,
        branchType: 'MAIN',
        licenseNumber: null,
        contactEmail: null,
        contactPhone: null,
        address: null,
        city: null,
        region: null,
        tenant: { tenantId, tenantName: 'Sunbird' },
        status: BranchStatus.ACTIVE,
        isHeadquarters: true,
        createdAt: null,
        updatedAt: null,
      } as Branch,
    ]);

    await expect(service.findAll(tenantId)).resolves.toEqual([
      {
        branchId: '220e2fd1-5400-4f13-932c-0c8e9570380a',
        branchCode: 'RIYADH',
        branchName: 'Riyadh',
        branchNameAr: null,
        branchType: 'MAIN',
        isHeadquarters: true,
        licenseNumber: null,
        contactEmail: null,
        contactPhone: null,
        address: null,
        city: null,
        region: null,
        tenantName: 'Sunbird',
        tenantId,
        status: BranchStatus.ACTIVE,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    expect(repository.find).toHaveBeenCalledWith({
      where: { isDeleted: false, tenant: { tenantId } },
      relations: { tenant: true },
      order: { createdAt: 'DESC' },
    });
  });

  it('updates status, tenant-scopes the lookup, and writes an audit event', async () => {
    const tenantId = '6e8c4164-356b-46e7-99d2-137449b84b59';
    const userId = 'd9b64e69-2450-4f05-bba0-c005404b1229';
    const branch = {
      branchId: '220e2fd1-5400-4f13-932c-0c8e9570380a',
      branchCode: 'RIYADH',
      branchName: 'Riyadh',
      branchNameAr: null,
      branchType: 'MAIN',
      isHeadquarters: true,
      licenseNumber: null,
      contactEmail: null,
      contactPhone: null,
      address: null,
      city: null,
      region: null,
      tenant: { tenantId, tenantName: 'Sunbird' },
      status: BranchStatus.ACTIVE,
      createdAt: null,
      updatedAt: null,
    } as Branch;
    repository.findOne.mockResolvedValue(branch);
    repository.save.mockImplementation((value) =>
      Promise.resolve(value as Branch),
    );
    auditLogs.save.mockImplementation((value) =>
      Promise.resolve(value as AuditLog),
    );

    await service.updateStatus(
      branch.branchId,
      BranchStatus.INACTIVE,
      tenantId,
      userId,
    );

    expect(repository.findOne).toHaveBeenCalledWith({
      where: {
        branchId: branch.branchId,
        isDeleted: false,
        tenant: { tenantId },
      },
      relations: { tenant: true },
    });
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: BranchStatus.INACTIVE,
        updatedBy: userId,
      }),
    );
    expect(auditLogs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        userId,
        actionType: 'UPDATE',
        entityType: 'BRANCH',
        entityId: branch.branchId,
      }),
    );
  });

  it('creates a branch after checking code and tenant branch limit', async () => {
    const tenantId = '6e8c4164-356b-46e7-99d2-137449b84b59';
    const userId = 'd9b64e69-2450-4f05-bba0-c005404b1229';
    const tenant = {
      tenantId,
      tenantName: 'Sunbird',
      status: TenantStatus.ACTIVE,
      maxBranches: 10,
    } as Tenant;
    tenants.findOne.mockResolvedValue(tenant);
    repository.exists.mockResolvedValue(false);
    repository.count.mockResolvedValue(2);
    repository.create.mockImplementation((value) => value as Branch);
    repository.save.mockImplementation((value) =>
      Promise.resolve({
        ...value,
        branchId: '220e2fd1-5400-4f13-932c-0c8e9570380a',
        createdAt: null,
        updatedAt: null,
      } as Branch),
    );
    auditLogs.save.mockImplementation((value) =>
      Promise.resolve(value as AuditLog),
    );

    const result = await service.create(
      {
        tenantId,
        branchCode: 'RIYADH-2',
        branchName: 'Riyadh Branch 2',
        branchType: BranchType.REGIONAL,
      },
      tenantId,
      userId,
    );

    expect(repository.exists).toHaveBeenCalledWith({
      where: { tenant: { tenantId }, branchCode: 'RIYADH-2' },
    });
    expect(repository.count).toHaveBeenCalledWith({
      where: { tenant: { tenantId }, isDeleted: false },
    });
    expect(result).toMatchObject({
      branchCode: 'RIYADH-2',
      branchName: 'Riyadh Branch 2',
      tenantId,
      tenantName: 'Sunbird',
      status: BranchStatus.ACTIVE,
    });
  });

  it('rejects creating a second HQ branch for a tenant', async () => {
    const tenantId = '6e8c4164-356b-46e7-99d2-137449b84b59';
    tenants.findOne.mockResolvedValue({
      tenantId,
      status: TenantStatus.ACTIVE,
      maxBranches: 10,
    } as Tenant);
    repository.exists.mockResolvedValue(false);
    repository.count.mockResolvedValue(1);
    repository.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(1),
    } as never);

    await expect(
      service.create(
        {
          tenantId,
          branchCode: 'SECOND-HQ',
          branchName: 'Second HQ',
          branchType: BranchType.MAIN,
          isHeadquarters: true,
        },
        tenantId,
        'd9b64e69-2450-4f05-bba0-c005404b1229',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects deleting an HQ branch while other branches exist', async () => {
    const tenantId = '6e8c4164-356b-46e7-99d2-137449b84b59';
    const branch = {
      branchId: '220e2fd1-5400-4f13-932c-0c8e9570380a',
      tenant: { tenantId },
      isHeadquarters: true,
    } as Branch;
    const builder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(1),
    };
    repository.findOne.mockResolvedValue(branch);
    repository.createQueryBuilder.mockReturnValue(builder as never);

    await expect(
      service.delete(
        branch.branchId,
        tenantId,
        'd9b64e69-2450-4f05-bba0-c005404b1229',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.save).not.toHaveBeenCalled();
  });
});
