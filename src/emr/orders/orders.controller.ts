import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { actorOf } from '../../fhir/medplum-actor';
import type { AuthenticatedRequest } from '../common/request';
import { EMR_PERMISSIONS } from '../emr.constants';
import { searchCatalog } from './order-catalog';
import {
  CancelOrderDto,
  CatalogQueryDto,
  CreateOrderDto,
  OrdersQueryDto,
  type OrderRow,
} from './orders.dto';
import { OrdersService } from './orders.service';

@ApiTags('emr-orders')
@ApiCookieAuth('cookieAuth')
@Controller('emr/orders')
@UseGuards(PermissionsGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** LOINC search for the order form. */
  @Get('catalog')
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  catalog(@Query() query: CatalogQueryDto) {
    return { items: searchCatalog(query.type, query.q) };
  }

  @Get()
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  list(
    @Req() req: AuthenticatedRequest,
    @Query() query: OrdersQueryDto,
  ): Promise<{ items: OrderRow[] }> {
    return this.orders.list(query, actorOf(req.user));
  }

  @Get(':id')
  @RequirePermissions(EMR_PERMISSIONS.clinical.read)
  get(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderRow> {
    return this.orders.get(id, actorOf(req.user));
  }

  @Post()
  @RequirePermissions(EMR_PERMISSIONS.clinical.create)
  create(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateOrderDto,
  ): Promise<OrderRow> {
    return this.orders.create(body, actorOf(req.user));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(EMR_PERMISSIONS.clinical.update)
  cancel(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelOrderDto,
  ): Promise<OrderRow> {
    return this.orders.cancel(id, body.reason, actorOf(req.user));
  }
}
