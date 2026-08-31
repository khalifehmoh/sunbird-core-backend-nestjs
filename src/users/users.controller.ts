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
  BulkUpdateUserStatusDto,
  EffectivePermissionDto,
  PagedResponseDto,
  UpdateUserStatusDto,
  UserGroupResponseDto,
  UserRequestDto,
  UserResponseDto,
  UserRoleResponseDto,
  UserSessionResponseDto,
} from './dto/user.dto';
import { UsersService } from './users.service';
import type { UserListQuery } from './users.service';

type AuthenticatedRequest = Request & { user: User };

@ApiTags('users')
@ApiCookieAuth('cookieAuth')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOkResponse({ description: 'Paged user list' })
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query() query: UserListQuery,
  ): Promise<PagedResponseDto<UserResponseDto>> {
    return this.usersService.findPaged(this.tenantScope(req.user), query);
  }

  @Patch('bulk-status')
  @ApiOkResponse({ description: 'Bulk status update count' })
  bulkUpdateStatus(
    @Req() req: AuthenticatedRequest,
    @Body() body: BulkUpdateUserStatusDto,
  ): Promise<{ updated: number }> {
    return this.usersService.bulkUpdateStatus(
      body.userIds,
      body.status,
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Get(':id')
  @ApiOkResponse({ type: UserResponseDto })
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<UserResponseDto> {
    return this.usersService.findOne(
      this.validateUuid(id),
      this.tenantScope(req.user),
    );
  }

  @Post()
  @ApiCreatedResponse({ type: UserResponseDto })
  create(
    @Req() req: AuthenticatedRequest,
    @Body() body: UserRequestDto,
  ): Promise<UserResponseDto> {
    return this.usersService.create(
      body,
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Put(':id')
  @ApiOkResponse({ type: UserResponseDto })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UserRequestDto,
  ): Promise<UserResponseDto> {
    return this.usersService.update(
      this.validateUuid(id),
      body,
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Patch(':id/status')
  @ApiOkResponse({ type: UserResponseDto })
  updateStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateUserStatusDto,
  ): Promise<UserResponseDto> {
    return this.usersService.updateStatus(
      this.validateUuid(id),
      body.status,
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Post(':id/reset-password')
  @ApiOkResponse({ type: UserResponseDto })
  resetPassword(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<UserResponseDto> {
    return this.usersService.resetPassword(
      this.validateUuid(id),
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
    return this.usersService.delete(
      this.validateUuid(id),
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Get(':id/sessions')
  @ApiOkResponse({ type: [UserSessionResponseDto] })
  listSessions(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<UserSessionResponseDto[]> {
    return this.usersService.listSessions(
      this.validateUuid(id),
      this.tenantScope(req.user),
    );
  }

  @Delete(':id/sessions/all')
  @ApiOkResponse({ description: 'Terminated session count' })
  terminateAllSessions(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ terminated: number }> {
    return this.usersService.terminateAllSessions(
      this.validateUuid(id),
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Get(':id/roles')
  @ApiOkResponse({ type: [UserRoleResponseDto] })
  listRoles(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<UserRoleResponseDto[]> {
    return this.usersService.listRoles(
      this.validateUuid(id),
      this.tenantScope(req.user),
    );
  }

  @Post(':id/roles/:roleId')
  @ApiCreatedResponse({ type: UserRoleResponseDto })
  assignRole(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('roleId') roleId: string,
  ): Promise<UserRoleResponseDto> {
    return this.usersService.assignUserRole(
      this.validateUuid(id),
      this.validateUuid(roleId, 'roleId'),
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Delete(':id/roles/:roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  revokeRole(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('roleId') roleId: string,
  ): Promise<void> {
    return this.usersService.revokeUserRole(
      this.validateUuid(id),
      this.validateUuid(roleId, 'roleId'),
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Get(':id/groups')
  @ApiOkResponse({ type: [UserGroupResponseDto] })
  listGroups(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<UserGroupResponseDto[]> {
    return this.usersService.listGroups(
      this.validateUuid(id),
      this.tenantScope(req.user),
    );
  }

  @Get(':id/effective-permissions')
  @ApiOkResponse({ type: [EffectivePermissionDto] })
  listEffectivePermissions(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<EffectivePermissionDto[]> {
    return this.usersService.listEffectivePermissions(
      this.validateUuid(id),
      this.tenantScope(req.user),
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
