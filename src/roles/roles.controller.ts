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
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { isPlatformAdmin } from '../auth/user-role.enum';
import { User } from '../database/entities/user.entity';
import {
  BatchRolePermissionsDto,
  PagedResponseDto,
  RoleOptionDto,
  RolePermissionItemDto,
  RoleRequestDto,
  RoleResponseDto,
} from './dto/role.dto';
import { RolesService } from './roles.service';
import type { RoleListQuery } from './roles.service';

type AuthenticatedRequest = Request & { user: User };

const PAGED_QUERY_KEYS: (keyof RoleListQuery)[] = [
  'page',
  'size',
  'sort',
  'search',
  'status',
  'isSystem',
];

@ApiTags('roles')
@ApiCookieAuth('cookieAuth')
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @ApiOkResponse({
    description:
      'Assignable role options without paging keys; paged list otherwise.',
  })
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query() query: RoleListQuery,
  ): Promise<RoleOptionDto[] | PagedResponseDto<RoleResponseDto>> {
    const tenantScopeId = this.tenantScope(req.user);
    const hasPagingOrFilter = PAGED_QUERY_KEYS.some(
      (key) => query[key] !== undefined,
    );
    return hasPagingOrFilter
      ? this.rolesService.findPaged(tenantScopeId, query)
      : this.rolesService.listAssignable(tenantScopeId, query.tenantId);
  }

  @Get(':id/permissions')
  @ApiOkResponse({ type: [RolePermissionItemDto] })
  listPermissions(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<RolePermissionItemDto[]> {
    return this.rolesService.listPermissions(
      this.validateUuid(id),
      this.tenantScope(req.user),
    );
  }

  @Post(':id/permissions/batch')
  @ApiOkResponse({ type: [RolePermissionItemDto] })
  batchPermissions(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: BatchRolePermissionsDto,
  ): Promise<RolePermissionItemDto[]> {
    return this.rolesService.batchPermissions(
      this.validateUuid(id),
      body,
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Post(':id/permissions/:permId')
  @ApiCreatedResponse({ type: RolePermissionItemDto })
  grantPermission(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('permId') permId: string,
  ): Promise<RolePermissionItemDto> {
    return this.rolesService.grantPermission(
      this.validateUuid(id),
      this.validateUuid(permId, 'permId'),
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Delete(':id/permissions/:permId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  revokePermission(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('permId') permId: string,
  ): Promise<void> {
    return this.rolesService.revokePermission(
      this.validateUuid(id),
      this.validateUuid(permId, 'permId'),
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Get(':id')
  @ApiOkResponse({ type: RoleResponseDto })
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<RoleResponseDto> {
    return this.rolesService.findOne(
      this.validateUuid(id),
      this.tenantScope(req.user),
    );
  }

  @Post()
  @ApiCreatedResponse({ type: RoleResponseDto })
  create(
    @Req() req: AuthenticatedRequest,
    @Body() body: RoleRequestDto,
  ): Promise<RoleResponseDto> {
    return this.rolesService.create(
      body,
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Put(':id')
  @ApiOkResponse({ type: RoleResponseDto })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: RoleRequestDto,
  ): Promise<RoleResponseDto> {
    return this.rolesService.update(
      this.validateUuid(id),
      body,
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
    return this.rolesService.delete(
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

  private validateUuid(id: string, name = 'id'): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      throw new BadRequestException(`Invalid value for parameter '${name}'`);
    }
    return id;
  }
}
