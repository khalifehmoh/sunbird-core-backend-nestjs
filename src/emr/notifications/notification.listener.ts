import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Patient } from '@medplum/fhirtypes';
import type { Subscription } from 'rxjs';
import { DataSource } from 'typeorm';
import { systemActor } from '../../fhir/medplum-actor';
import { localParts } from '../appointments/scheduling';
import { FhirAccess } from '../common/fhir-access';
import { EmrEventBus, type EmrEvent } from '../emr-events';
import { mobileOf, patientNames } from '../fhir-utils';
import type { NotificationLanguage } from '../emr.entities';
import { NotificationsService } from './notifications.service';

/** Which template an event triggers. */
const TRIGGERS: Record<string, string> = {
  'emr.adt/A01': 'NOTIF_ADT_ADMIT',
  'emr.adt/A03': 'NOTIF_ADT_DISCHARGE',
  'emr.adt/A28': 'NOTIF_PATIENT_WELCOME',
  'emr.sch/S12': 'NOTIF_SCH_BOOKED',
  'emr.sch/S14': 'NOTIF_SCH_CANCELLED',
};

export function triggerFor(event: Pick<EmrEvent, 'channel' | 'event'>) {
  return TRIGGERS[`${event.channel}/${event.event}`];
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** `4 Oct 2026` and `09:30` in clinic-local time. */
export function formatWhen(iso: string | undefined | null): {
  date?: string;
  time?: string;
} {
  if (!iso) return {};
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return {};
  const parts = localParts(ms);
  const [year, month, day] = parts.date.split('-').map(Number);
  const hours = Math.floor(parts.minutesIntoDay / 60);
  const minutes = parts.minutesIntoDay % 60;
  return {
    date: `${day} ${MONTHS[month - 1]} ${year}`,
    time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
  };
}

export function languageOf(patient: Patient | undefined): NotificationLanguage {
  const preferred = patient?.communication?.find((entry) => entry.preferred);
  const code = (preferred ?? patient?.communication?.[0])?.language?.coding?.[0]
    ?.code;
  return code?.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

/** Resolves the display name of a tenant's facility for message text. */
@Injectable()
export class FacilityNames {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async nameFor(
    tenantId: string,
    language: NotificationLanguage,
  ): Promise<string> {
    const rows: unknown = await this.dataSource.query(
      'SELECT tenant_name, tenant_name_ar FROM core.tenants WHERE tenant_id = $1',
      [tenantId],
    );
    const row = (Array.isArray(rows) ? rows[0] : undefined) as
      { tenant_name: string; tenant_name_ar: string | null } | undefined;
    if (!row) return '';
    return language === 'ar' && row.tenant_name_ar
      ? row.tenant_name_ar
      : row.tenant_name;
  }
}

/**
 * Turns EMR events into patient notifications. Runs after the event's own
 * transaction has committed and never affects it: a failure here is logged and
 * leaves the admission, booking or cancellation intact.
 */
@Injectable()
export class NotificationListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationListener.name);
  private subscription?: Subscription;

  constructor(
    private readonly bus: EmrEventBus,
    private readonly notifications: NotificationsService,
    private readonly fhir: FhirAccess,
    private readonly facilities: FacilityNames,
  ) {}

  onModuleInit(): void {
    this.subscription = this.bus.subscribe(
      (event) => this.handle(event),
      ['emr.adt', 'emr.sch'],
    );
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  async handle(event: EmrEvent): Promise<void> {
    const eventCode = triggerFor(event);
    if (!eventCode || !event.patientId) return;

    try {
      const patient = await this.fhir.readPatient(
        event.patientId,
        systemActor(event.tenantId),
      );
      const language = languageOf(patient);
      const data = event.data ?? {};
      const when = formatWhen(
        asString(data.start) ??
          asString(data.periodEnd) ??
          asString(data.periodStart),
      );
      const mrn = patient.identifier?.find((id) =>
        id.system?.endsWith('/mrn'),
      )?.value;

      await this.notifications.send({
        tenantId: event.tenantId,
        eventCode,
        language,
        recipient: mobileOf(patient),
        patientId: event.patientId,
        resource: event.resource,
        values: {
          patient_name: patientNames(patient).name,
          mrn,
          facility: await this.facilities.nameFor(event.tenantId, language),
          visit_number: asString(data.visitNumber),
          ward: asString(data.location),
          provider: asString(data.practitioner),
          reason: asString(data.reason),
          ...when,
        },
      });
    } catch (error) {
      this.logger.error(
        `Could not notify for ${event.channel}/${event.event}: ${String(error)}`,
      );
    }
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
