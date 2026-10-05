import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { User } from '../database/entities/user.entity';
import { AdtService } from './adt.service';
import { PATIENT_MGMT_PERMISSIONS } from './fhir.constants';
import { actorOf } from './medplum-actor';
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
@UseGuards(PermissionsGuard)
export class AdtController {
  constructor(private readonly adtService: AdtService) {}

  @Post('admit')
  @RequirePermissions(PATIENT_MGMT_PERMISSIONS.create)
  @ApiCreatedResponse({ type: EncounterResponseDto })
  admit(
    @Req() req: AuthenticatedRequest,
    @Body() body: AdmitRequestDto,
  ): Promise<EncounterResponseDto> {
    return this.adtService.admit(body, actorOf(req.user));
  }

  @Post('register')
  @RequirePermissions(PATIENT_MGMT_PERMISSIONS.create)
  @ApiCreatedResponse({ type: EncounterResponseDto })
  register(
    @Req() req: AuthenticatedRequest,
    @Body() body: RegisterVisitRequestDto,
  ): Promise<EncounterResponseDto> {
    return this.adtService.register(body, actorOf(req.user));
  }

  @Post('transfer')
  @RequirePermissions(PATIENT_MGMT_PERMISSIONS.update)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: EncounterResponseDto })
  transfer(
    @Req() req: AuthenticatedRequest,
    @Body() body: TransferRequestDto,
  ): Promise<EncounterResponseDto> {
    return this.adtService.transfer(body, actorOf(req.user));
  }

  @Post('discharge')
  @RequirePermissions(PATIENT_MGMT_PERMISSIONS.update)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: EncounterResponseDto })
  discharge(
    @Req() req: AuthenticatedRequest,
    @Body() body: DischargeRequestDto,
  ): Promise<EncounterResponseDto> {
    return this.adtService.discharge(body, actorOf(req.user));
  }

  @Post('preadmit')
  @RequirePermissions(PATIENT_MGMT_PERMISSIONS.create)
  @ApiCreatedResponse({ type: EncounterResponseDto })
  preadmit(
    @Req() req: AuthenticatedRequest,
    @Body() body: PreadmitRequestDto,
  ): Promise<EncounterResponseDto> {
    return this.adtService.preadmit(body, actorOf(req.user));
  }

  @Post('preadmit/:id/admit')
  @RequirePermissions(PATIENT_MGMT_PERMISSIONS.create)
  @ApiOkResponse({ type: EncounterResponseDto })
  convertPreadmit(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Omit<AdmitRequestDto, 'patientId'>,
  ): Promise<EncounterResponseDto> {
    return this.adtService.convertPreadmitToAdmit(
      this.validateUuid(id),
      body,
      actorOf(req.user),
    );
  }

  @Get('encounters/:id')
  @RequirePermissions(PATIENT_MGMT_PERMISSIONS.read)
  @ApiOkResponse({ type: EncounterResponseDto })
  getEncounter(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<EncounterResponseDto> {
    return this.adtService.getEncounter(
      this.validateUuid(id),
      actorOf(req.user),
    );
  }

  @Get('beds')
  @RequirePermissions(PATIENT_MGMT_PERMISSIONS.read)
  @ApiOkResponse({ type: BedBoardResponseDto })
  bedBoard(@Req() req: AuthenticatedRequest): Promise<BedBoardResponseDto> {
    return this.adtService.bedBoard(actorOf(req.user));
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
