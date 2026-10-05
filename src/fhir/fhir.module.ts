import { Module } from '@nestjs/common';
import { AdtController } from './adt.controller';
import { AdtService } from './adt.service';
import { CapabilityController } from './capability.controller';
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
  // Capability first: its `R4/metadata` must win over the gateway wildcard.
  controllers: [CapabilityController, FhirGatewayController, AdtController],
  providers: [MedplumRegistry, MedplumService, AdtService],
  exports: [MedplumRegistry, MedplumService],
})
export class FhirModule {}
