import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { isPlatformAdmin } from '../auth/user-role.enum';
import { User } from '../database/entities/user.entity';
import {
  ActiveSessionResponseDto,
  PagedResponseDto,
} from './dto/user.dto';
import { UsersService } from './users.service';
import type { ActiveSessionListQuery } from './users.service';

type AuthenticatedRequest = Request & { user: User };

@ApiTags('sessions')
@ApiCookieAuth('cookieAuth')
@Controller('sessions')
export class SessionsController {
  constructor(private readonly usersService: UsersService) {}

  @Get('active')
  @ApiOkResponse({ description: 'Paged active sessions' })
  listActive(
    @Req() req: AuthenticatedRequest,
    @Query() query: ActiveSessionListQuery,
  ): Promise<PagedResponseDto<ActiveSessionResponseDto>> {
    return this.usersService.listActiveSessions(
      this.tenantScope(req.user),
      query,
    );
  }

  @Delete(':sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  terminate(
    @Req() req: AuthenticatedRequest,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    return this.usersService.terminateSession(
      this.validateUuid(sessionId),
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
      throw new BadRequestException("Invalid value for parameter 'sessionId'");
    }
    return id;
  }
}
