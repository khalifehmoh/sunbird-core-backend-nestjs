import { Test, TestingModule } from '@nestjs/testing';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';
import { UserRole } from '../auth/user-role.enum';
import { BranchStatus } from './branch-status.enum';
import { BranchType } from './branch-type.enum';

describe('BranchesController', () => {
  let controller: BranchesController;
  let service: {
    findAll: jest.Mock;
    findPaged: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateStatus: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findPaged: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateStatus: jest.fn(),
      delete: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BranchesController],
      providers: [{ provide: BranchesService, useValue: service }],
    }).compile();

    controller = module.get<BranchesController>(BranchesController);
  });

  it('gets all branches for the authenticated user tenant', async () => {
    const tenantId = '6e8c4164-356b-46e7-99d2-137449b84b59';
    service.findAll.mockResolvedValue([]);

    await expect(
      controller.findAll({ user: { tenant: { tenantId } } } as never, {}),
    ).resolves.toEqual([]);
    expect(service.findAll).toHaveBeenCalledWith(tenantId);
    expect(service.findPaged).not.toHaveBeenCalled();
  });

  it('uses the paged query when filters are present', async () => {
    const tenantId = '6e8c4164-356b-46e7-99d2-137449b84b59';
    const query = { status: 'ACTIVE' };
    service.findPaged.mockResolvedValue({
      content: [],
      page: 0,
      size: 20,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });

    await controller.findAll(
      { user: { tenant: { tenantId } } } as never,
      query,
    );
    expect(service.findPaged).toHaveBeenCalledWith(tenantId, query);
  });

  it('allows an admin to filter branches by tenant', async () => {
    const query = {
      tenantId: '6e8c4164-356b-46e7-99d2-137449b84b59',
    };
    service.findPaged.mockResolvedValue({
      content: [],
      page: 0,
      size: 20,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });

    await controller.findAll(
      {
        user: {
          role: UserRole.ADMIN,
          tenant: null,
        },
      } as never,
      query,
    );

    expect(service.findPaged).toHaveBeenCalledWith(undefined, query);
  });

  it('updates branch status within the authenticated tenant scope', async () => {
    const tenantId = '6e8c4164-356b-46e7-99d2-137449b84b59';
    const userId = 'd9b64e69-2450-4f05-bba0-c005404b1229';
    const branchId = '220e2fd1-5400-4f13-932c-0c8e9570380a';
    service.updateStatus.mockResolvedValue({ status: BranchStatus.INACTIVE });

    await controller.updateStatus(
      {
        user: {
          userId,
          role: UserRole.MANAGER,
          tenant: { tenantId },
        },
      } as never,
      branchId,
      { status: BranchStatus.INACTIVE },
    );

    expect(service.updateStatus).toHaveBeenCalledWith(
      branchId,
      BranchStatus.INACTIVE,
      tenantId,
      userId,
    );
  });

  it('creates a branch in the authenticated tenant scope', async () => {
    const tenantId = '6e8c4164-356b-46e7-99d2-137449b84b59';
    const userId = 'd9b64e69-2450-4f05-bba0-c005404b1229';
    const body = {
      tenantId,
      branchCode: 'RIYADH-2',
      branchName: 'Riyadh Branch 2',
      branchType: BranchType.REGIONAL,
    };
    service.create.mockResolvedValue({ branchCode: body.branchCode });

    await controller.create(
      {
        user: {
          userId,
          role: UserRole.MANAGER,
          tenant: { tenantId },
        },
      } as never,
      body,
    );

    expect(service.create).toHaveBeenCalledWith(body, tenantId, userId);
  });

  it('loads a branch for editing within the authenticated tenant scope', async () => {
    const tenantId = '6e8c4164-356b-46e7-99d2-137449b84b59';
    const branchId = '220e2fd1-5400-4f13-932c-0c8e9570380a';
    service.findOne.mockResolvedValue({ branchId });

    await controller.findOne(
      {
        user: {
          role: UserRole.MANAGER,
          tenant: { tenantId },
        },
      } as never,
      branchId,
    );

    expect(service.findOne).toHaveBeenCalledWith(branchId, tenantId);
  });

  it('soft-deletes a branch within the authenticated tenant scope', async () => {
    const tenantId = '6e8c4164-356b-46e7-99d2-137449b84b59';
    const userId = 'd9b64e69-2450-4f05-bba0-c005404b1229';
    const branchId = '220e2fd1-5400-4f13-932c-0c8e9570380a';
    service.delete.mockResolvedValue(undefined);

    await controller.delete(
      {
        user: {
          userId,
          role: UserRole.MANAGER,
          tenant: { tenantId },
        },
      } as never,
      branchId,
    );

    expect(service.delete).toHaveBeenCalledWith(branchId, tenantId, userId);
  });
});
