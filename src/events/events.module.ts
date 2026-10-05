import { Module } from '@nestjs/common';
import { FhirModule } from '../fhir/fhir.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

/**
 * Event-driven spike: Medplum Subscription → Nest webhook → BullMQ → FHIR write.
 * The Bot half is provisioned in Medplum itself (`npm run medplum:events`).
 */
@Module({
  imports: [FhirModule],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
