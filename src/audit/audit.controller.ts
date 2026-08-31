import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { isPlatformAdmin } from '../auth/user-role.enum';
import { User } from '../database/entities/user.entity';
import { AuditService } from './audit.service';
import type { AuditListQuery } from './audit.service';
import {
  AuditLogResponseDto,
  PagedResponseDto,
} from './dto/audit.dto';

type AuthenticatedRequest = Request & { user: User };

@ApiTags('audit')
@ApiCookieAuth('cookieAuth')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="audit-logs.csv"')
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'CSV download of filtered audit events' })
  export(
    @Req() req: AuthenticatedRequest,
    @Query() query: AuditListQuery,
  ): Promise<string> {
    return this.auditService.exportCsv(this.tenantScope(req.user), query);
  }

  @Get()
  @ApiOkResponse({ description: 'Paged audit log, newest first' })
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query() query: AuditListQuery,
  ): Promise<PagedResponseDto<AuditLogResponseDto>> {
    return this.auditService.findPaged(this.tenantScope(req.user), query);
  }

  @Get(':id')
  @ApiOkResponse({ type: AuditLogResponseDto })
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<AuditLogResponseDto> {
    return this.auditService.findOne(
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
