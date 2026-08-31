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
  GroupMemberResponseDto,
  GroupRequestDto,
  GroupResponseDto,
  GroupRoleResponseDto,
  PagedResponseDto,
} from './dto/group.dto';
import { GroupsService } from './groups.service';
import type { GroupListQuery } from './groups.service';

type AuthenticatedRequest = Request & { user: User };

@ApiTags('groups')
@ApiCookieAuth('cookieAuth')
@Controller('groups')
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Get()
  @ApiOkResponse({ description: 'Paged group list' })
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query() query: GroupListQuery,
  ): Promise<PagedResponseDto<GroupResponseDto>> {
    return this.groupsService.findPaged(this.tenantScope(req.user), query);
  }

  @Get(':id/members')
  @ApiOkResponse({ type: [GroupMemberResponseDto] })
  listMembers(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<GroupMemberResponseDto[]> {
    return this.groupsService.listMembers(
      this.validateUuid(id),
      this.tenantScope(req.user),
    );
  }

  @Get(':id/roles')
  @ApiOkResponse({ type: [GroupRoleResponseDto] })
  listRoles(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<GroupRoleResponseDto[]> {
    return this.groupsService.listRoles(
      this.validateUuid(id),
      this.tenantScope(req.user),
    );
  }

  @Get(':id')
  @ApiOkResponse({ type: GroupResponseDto })
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<GroupResponseDto> {
    return this.groupsService.findOne(
      this.validateUuid(id),
      this.tenantScope(req.user),
    );
  }

  @Post()
  @ApiCreatedResponse({ type: GroupResponseDto })
  create(
    @Req() req: AuthenticatedRequest,
    @Body() body: GroupRequestDto,
  ): Promise<GroupResponseDto> {
    return this.groupsService.create(
      body,
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Put(':id')
  @ApiOkResponse({ type: GroupResponseDto })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: GroupRequestDto,
  ): Promise<GroupResponseDto> {
    return this.groupsService.update(
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
    return this.groupsService.delete(
      this.validateUuid(id),
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Post(':id/members/:userId')
  @ApiCreatedResponse({ type: GroupMemberResponseDto })
  addMember(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ): Promise<GroupMemberResponseDto> {
    return this.groupsService.addMember(
      this.validateUuid(id),
      this.validateUuid(userId, 'userId'),
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removeMember(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    return this.groupsService.removeMember(
      this.validateUuid(id),
      this.validateUuid(userId, 'userId'),
      this.tenantScope(req.user),
      req.user.userId,
    );
  }

  @Post(':id/roles/:roleId')
  @ApiCreatedResponse({ type: GroupRoleResponseDto })
  assignRole(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('roleId') roleId: string,
  ): Promise<GroupRoleResponseDto> {
    return this.groupsService.assignRole(
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
    return this.groupsService.revokeRole(
      this.validateUuid(id),
      this.validateUuid(roleId, 'roleId'),
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
