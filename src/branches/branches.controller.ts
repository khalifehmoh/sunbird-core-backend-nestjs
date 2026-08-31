import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { BranchesService } from './branches.service';
import type { BranchListQuery } from './branches.service';
import {
  BranchRequestDto,
  BranchResponseDto,
  PagedResponseDto,
  UpdateBranchStatusDto,
} from './dto/branch.dto';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { User } from '../database/entities/user.entity';
import { isPlatformAdmin } from '../auth/user-role.enum';
import type { Request } from 'express';

type AuthenticatedRequest = Request & { user: User };

@ApiTags('branches')
@ApiCookieAuth('cookieAuth')
@Controller('branches')
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query() query: BranchListQuery,
  ): Promise<BranchResponseDto[] | PagedResponseDto<BranchResponseDto>> {
    const hasPagingOrFilter = [
      'page',
      'size',
      'sort',
      'search',
      'status',
      'tenantId',
      'hqOnly',
      'hq-only',
      'type',
    ].some((key) => query[key as keyof BranchListQuery] !== undefined);
    const tenantScopeId = this.tenantScope(req.user);
    return hasPagingOrFilter
      ? this.branchesService.findPaged(tenantScopeId, query)
      : this.branchesService.findAll(tenantScopeId);
  }

  @Get(':id')
  @ApiOkResponse({ type: BranchResponseDto })
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<BranchResponseDto> {
    return this.branchesService.findOne(
      this.validateUuid(id),
      this.tenantScope(req.user),
    );
  }

  @Post()
  @ApiCreatedResponse({ type: BranchResponseDto })
  create(
    @Req() req: AuthenticatedRequest,
    @Body() body: BranchRequestDto,
  ): Promise<BranchResponseDto> {
    return this.branchesService.create(
      body,
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Put(':id')
  @ApiOkResponse({ type: BranchResponseDto })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: BranchRequestDto,
  ): Promise<BranchResponseDto> {
    return this.branchesService.update(
      this.validateUuid(id),
      body,
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Patch(':id/status')
  @ApiOkResponse({ type: BranchResponseDto })
  updateStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateBranchStatusDto,
  ): Promise<BranchResponseDto> {
    return this.branchesService.updateStatus(
      this.validateUuid(id),
      body.status,
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  delete(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<void> {
    return this.branchesService.delete(
      this.validateUuid(id),
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  private tenantScope(user: User): string | undefined {
    if (isPlatformAdmin(user.role)) return undefined;
    if (!user.tenant?.tenantId) {
      throw new ForbiddenException('Tenant access is required');
    }
    return user.tenant.tenantId;
  }

  private validateUuid(id: string): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      throw new BadRequestException("Invalid value for parameter 'id'");
    }
    return id;
  }
}
