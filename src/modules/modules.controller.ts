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
  ModuleCatalogDto,
  ModuleRequestDto,
  ModuleResponseDto,
  PagedResponseDto,
} from './dto/module.dto';
import { ModulesService } from './modules.service';
import type { ModuleListQuery } from './modules.service';

type AuthenticatedRequest = Request & { user: User };

const PAGED_QUERY_KEYS: (keyof ModuleListQuery)[] = [
  'page',
  'size',
  'sort',
  'search',
  'status',
];

@ApiTags('modules')
@ApiCookieAuth('cookieAuth')
@Controller('modules')
export class ModulesController {
  constructor(private readonly modulesService: ModulesService) {}

  @Get()
  @ApiOkResponse({
    description:
      'Module catalog with nested permissions when no paging keys; paged list otherwise.',
  })
  findAll(
    @Query() query: ModuleListQuery,
  ): Promise<ModuleCatalogDto[] | PagedResponseDto<ModuleResponseDto>> {
    const hasPagingOrFilter = PAGED_QUERY_KEYS.some(
      (key) => query[key] !== undefined,
    );
    return hasPagingOrFilter
      ? this.modulesService.findPaged(query)
      : this.modulesService.listCatalog();
  }

  @Get(':id')
  @ApiOkResponse({ type: ModuleResponseDto })
  findOne(@Param('id') id: string): Promise<ModuleResponseDto> {
    return this.modulesService.findOne(this.validateUuid(id));
  }

  @Post()
  @ApiCreatedResponse({ type: ModuleResponseDto })
  create(
    @Req() req: AuthenticatedRequest,
    @Body() body: ModuleRequestDto,
  ): Promise<ModuleResponseDto> {
    return this.modulesService.create(body, req.user.userId);
  }

  @Put(':id')
  @ApiOkResponse({ type: ModuleResponseDto })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: ModuleRequestDto,
  ): Promise<ModuleResponseDto> {
    return this.modulesService.update(
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
    return this.modulesService.delete(this.validateUuid(id), req.user.userId);
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
