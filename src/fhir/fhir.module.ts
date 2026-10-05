import { Module } from '@nestjs/common';
import { AdtController } from './adt.controller';
import { AdtService } from './adt.service';
import { FhirGatewayController } from './fhir-gateway.controller';
import { MedplumRegistry } from './medplum-registry';
import { MedplumService } from './medplum.service';

/**
 * Clinical data, stored as FHIR in Medplum.
 *
 * Patient CRUD goes through the FHIR gateway (`/api/v1/fhir/R4`); there is no
 * parallel flat patients API. Nest services here are only for workflows FHIR
 * CRUD alone does not enforce (ADT bed occupancy, etc.).
 */
@Module({
  controllers: [FhirGatewayController, AdtController],
  providers: [MedplumRegistry, MedplumService, AdtService],
  exports: [MedplumRegistry, MedplumService],
})
export class FhirModule {}
