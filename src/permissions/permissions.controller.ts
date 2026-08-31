import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { User } from '../database/entities/user.entity';
import {
  PagedResponseDto,
  PermissionRequestDto,
  PermissionResponseDto,
} from './dto/permission.dto';
import { PermissionsService } from './permissions.service';
import type { PermissionListQuery } from './permissions.service';

type AuthenticatedRequest = Request & { user: User };

@ApiTags('permissions')
@ApiCookieAuth('cookieAuth')
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Get()
  @ApiOkResponse({ description: 'Paged permission list grouped by module' })
  findAll(
    @Query() query: PermissionListQuery,
  ): Promise<PagedResponseDto<PermissionResponseDto>> {
    return this.permissionsService.findPaged(query);
  }

  @Get(':id')
  @ApiOkResponse({ type: PermissionResponseDto })
  findOne(@Param('id') id: string): Promise<PermissionResponseDto> {
    return this.permissionsService.findOne(this.validateUuid(id));
  }

  @Post()
  @ApiCreatedResponse({ type: PermissionResponseDto })
  create(
    @Req() req: AuthenticatedRequest,
    @Body() body: PermissionRequestDto,
  ): Promise<PermissionResponseDto> {
    return this.permissionsService.create(body, req.user.userId);
  }

  @Put(':id')
  @ApiOkResponse({ type: PermissionResponseDto })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: PermissionRequestDto,
  ): Promise<PermissionResponseDto> {
    return this.permissionsService.update(
      this.validateUuid(id),
      body,
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
    return this.permissionsService.delete(
      this.validateUuid(id),
      req.user.userId,
    );
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
