import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  PagedResponseDto,
  TenantRequestDto,
  TenantResponseDto,
  UpdateTenantStatusDto,
} from './dto/tenant.dto';
import { TenantsService } from './tenants.service';
import type { TenantListQuery } from './tenants.service';

@ApiTags('tenants')
@ApiCookieAuth('cookieAuth')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  @ApiOkResponse({
    description: 'Array without query parameters; paged envelope otherwise.',
  })
  findAll(
    @Query() query: TenantListQuery,
  ): Promise<TenantResponseDto[] | PagedResponseDto<TenantResponseDto>> {
    const hasPagingOrFilter = [
      'page',
      'size',
      'sort',
      'search',
      'status',
      'type',
    ].some((key) => query[key as keyof TenantListQuery] !== undefined);
    return hasPagingOrFilter
      ? this.tenantsService.findPaged(query)
      : this.tenantsService.findAll();
  }

  @Get(':id')
  @ApiOkResponse({ type: TenantResponseDto })
  findOne(@Param('id') id: string): Promise<TenantResponseDto> {
    return this.tenantsService.findOne(this.validateUuid(id));
  }

  @Post()
  @ApiCreatedResponse({ type: TenantResponseDto })
  create(@Body() request: TenantRequestDto): Promise<TenantResponseDto> {
    return this.tenantsService.create(request);
  }

  @Put(':id')
  @ApiOkResponse({ type: TenantResponseDto })
  update(
    @Param('id') id: string,
    @Body() request: TenantRequestDto,
  ): Promise<TenantResponseDto> {
    return this.tenantsService.update(this.validateUuid(id), request);
  }

  @Patch(':id/status')
  @ApiOkResponse({ type: TenantResponseDto })
  updateStatus(
    @Param('id') id: string,
    @Body() body: UpdateTenantStatusDto,
  ): Promise<TenantResponseDto> {
    return this.tenantsService.updateStatus(this.validateUuid(id), body.status);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  delete(@Param('id') id: string): Promise<void> {
    return this.tenantsService.delete(this.validateUuid(id));
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
