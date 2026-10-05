import { Controller, Get, Header, Req } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { CapabilityStatement } from '@medplum/fhirtypes';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { buildCapabilityStatement } from './capability-statement';
import { FHIR_JSON_CONTENT_TYPE } from './fhir.constants';

/**
 * Public FHIR discovery (blueprint page 31; NPHIES reads it). Declared before
 * the gateway so `fhir/R4/metadata` answers here, without a session, rather
 * than being forwarded.
 */
@ApiTags('fhir')
@Controller('fhir')
export class CapabilityController {
  @Public()
  @Get(['metadata', 'R4/metadata'])
  @Header('Content-Type', FHIR_JSON_CONTENT_TYPE)
  @ApiOkResponse({ description: 'FHIR R4 CapabilityStatement' })
  metadata(@Req() req: Request): CapabilityStatement {
    const host = req.get('host') ?? 'localhost';
    return buildCapabilityStatement({
      baseUrl: `${req.protocol}://${host}/api/v1/fhir/R4`,
    });
  }
}
