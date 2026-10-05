import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FhirModule } from '../fhir/fhir.module';
import { AppointmentsController } from './appointments/appointments.controller';
import { AppointmentsService } from './appointments/appointments.service';
import { FhirAccess } from './common/fhir-access';
import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { DiagnosesController } from './diagnoses/diagnoses.controller';
import { DiagnosesService } from './diagnoses/diagnoses.service';
import { EmrCommonModule } from './emr-events';
import { EMR_ENTITIES } from './emr.entities';
import { IntegrationController } from './integration/integration.controller';
import { IntegrationService } from './integration/integration.service';
import { MessageStore, TypeOrmMessageStore } from './integration/message.store';
import {
  NOTIFICATION_PROVIDER,
  DemoNotificationProvider,
} from './notifications/notification-provider';
import {
  FacilityNames,
  NotificationListener,
} from './notifications/notification.listener';
import {
  NotificationStore,
  TypeOrmNotificationStore,
} from './notifications/notification.store';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { PatientsController } from './patients/patients.controller';
import { PatientsService } from './patients/patients.service';
import { ResultsController } from './results/results.controller';
import { ResultsService } from './results/results.service';
import { SequenceService } from './sequence.service';
import { VitalsController } from './vitals/vitals.controller';
import { VitalsService } from './vitals/vitals.service';

/**
 * The EMR workflows around the FHIR data: patients, orders, results,
 * scheduling, vitals, diagnoses, the HL7 integration pipeline, notifications
 * and the dashboard. Clinical data stays in Medplum; the tables here hold only
 * what FHIR does not (counters, message traffic, notification templates/logs).
 */
@Module({
  imports: [
    FhirModule,
    EmrCommonModule,
    TypeOrmModule.forFeature([...EMR_ENTITIES]),
  ],
  controllers: [
    DashboardController,
    PatientsController,
    OrdersController,
    ResultsController,
    AppointmentsController,
    VitalsController,
    DiagnosesController,
    IntegrationController,
    NotificationsController,
  ],
  providers: [
    FhirAccess,
    SequenceService,
    DashboardService,
    PatientsService,
    OrdersService,
    ResultsService,
    AppointmentsService,
    VitalsService,
    DiagnosesService,
    IntegrationService,
    NotificationsService,
    NotificationListener,
    FacilityNames,
    { provide: MessageStore, useClass: TypeOrmMessageStore },
    { provide: NotificationStore, useClass: TypeOrmNotificationStore },
    // Demo only: logs instead of sending. Swap for a real SMS / WhatsApp / email provider.
    { provide: NOTIFICATION_PROVIDER, useClass: DemoNotificationProvider },
  ],
})
export class EmrModule {}
