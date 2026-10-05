import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { User } from '../database/entities/user.entity';
import { AdtService } from './adt.service';
import {
  AdmitRequestDto,
  BedBoardResponseDto,
  DischargeRequestDto,
  EncounterResponseDto,
  PreadmitRequestDto,
  RegisterVisitRequestDto,
  TransferRequestDto,
} from './dto/adt.dto';

type AuthenticatedRequest = Request & { user: User };

/**
 * ADT A01–A05 as REST actions. Clinical state is FHIR Encounter / Location in
 * Medplum; this controller is the transactional front door (bed conflicts,
 * visit numbers, tenant checks) that `@medplum/react` forms call into.
 */
@ApiTags('adt')
@ApiCookieAuth('cookieAuth')
@Controller('adt')
export class AdtController {
  constructor(private readonly adtService: AdtService) {}

  @Post('admit')
  @ApiCreatedResponse({ type: EncounterResponseDto })
  admit(
    @Req() req: AuthenticatedRequest,
    @Body() body: AdmitRequestDto,
  ): Promise<EncounterResponseDto> {
    return this.adtService.admit(body, this.tenantId(req));
  }

  @Post('register')
  @ApiCreatedResponse({ type: EncounterResponseDto })
  register(
    @Req() req: AuthenticatedRequest,
    @Body() body: RegisterVisitRequestDto,
  ): Promise<EncounterResponseDto> {
    return this.adtService.register(body, this.tenantId(req));
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: EncounterResponseDto })
  transfer(
    @Req() req: AuthenticatedRequest,
    @Body() body: TransferRequestDto,
  ): Promise<EncounterResponseDto> {
    return this.adtService.transfer(body, this.tenantId(req));
  }

  @Post('discharge')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: EncounterResponseDto })
  discharge(
    @Req() req: AuthenticatedRequest,
    @Body() body: DischargeRequestDto,
  ): Promise<EncounterResponseDto> {
    return this.adtService.discharge(body, this.tenantId(req));
  }

  @Post('preadmit')
  @ApiCreatedResponse({ type: EncounterResponseDto })
  preadmit(
    @Req() req: AuthenticatedRequest,
    @Body() body: PreadmitRequestDto,
  ): Promise<EncounterResponseDto> {
    return this.adtService.preadmit(body, this.tenantId(req));
  }

  @Post('preadmit/:id/admit')
  @ApiOkResponse({ type: EncounterResponseDto })
  convertPreadmit(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Omit<AdmitRequestDto, 'patientId'>,
  ): Promise<EncounterResponseDto> {
    return this.adtService.convertPreadmitToAdmit(
      this.validateUuid(id),
      body,
      this.tenantId(req),
    );
  }

  @Get('encounters/:id')
  @ApiOkResponse({ type: EncounterResponseDto })
  getEncounter(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<EncounterResponseDto> {
    return this.adtService.getEncounter(
      this.validateUuid(id),
      this.tenantId(req),
    );
  }

  @Get('beds')
  @ApiOkResponse({ type: BedBoardResponseDto })
  bedBoard(@Req() req: AuthenticatedRequest): Promise<BedBoardResponseDto> {
    return this.adtService.bedBoard(this.tenantId(req));
  }

  private tenantId(req: AuthenticatedRequest): string {
    const tenantId = req.user?.tenant?.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('User is not associated with a tenant');
    }
    return tenantId;
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
