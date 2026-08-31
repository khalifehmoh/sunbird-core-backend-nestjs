import { Test } from '@nestjs/testing';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

describe('TenantsController', () => {
  let controller: TenantsController;
  const service = {
    findAll: jest.fn(),
    findPaged: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [TenantsController],
      providers: [{ provide: TenantsService, useValue: service }],
    }).compile();
    controller = module.get(TenantsController);
  });

  it('uses the unpaged array mode when no query parameter is supplied', async () => {
    service.findAll.mockResolvedValue([]);
    await expect(controller.findAll({})).resolves.toEqual([]);
    expect(service.findAll).toHaveBeenCalledTimes(1);
    expect(service.findPaged).not.toHaveBeenCalled();
  });

  it.each(['page', 'size', 'sort', 'search', 'status', 'type'] as const)(
    'uses paged mode when %s is supplied',
    async (parameter) => {
      service.findPaged.mockResolvedValue({ content: [] });
      const query = { [parameter]: '' };
      await controller.findAll(query);
      expect(service.findPaged).toHaveBeenCalledWith(query);
    },
  );

  it('rejects malformed UUID path values', () => {
    expect(() => controller.findOne('not-a-uuid')).toThrow(
      "Invalid value for parameter 'id'",
    );
  });

  it('delegates status updates to the service', async () => {
    const id = '6e8c4164-356b-46e7-99d2-137449b84b59';
    service.updateStatus.mockResolvedValue({ status: 'SUSPENDED' });
    await expect(
      controller.updateStatus(id, { status: 'SUSPENDED' as never }),
    ).resolves.toEqual({ status: 'SUSPENDED' });
    expect(service.updateStatus).toHaveBeenCalledWith(id, 'SUSPENDED');
  });
});
