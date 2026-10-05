import { Injectable } from '@nestjs/common';
import type { Appointment, Encounter, Patient } from '@medplum/fhirtypes';
import { toEncounterResponse } from '../../fhir/adt.mapper';
import type { MedplumActor } from '../../fhir/medplum-actor';
import { FhirAccess } from '../common/fhir-access';
import { SCHEDULING } from '../emr.constants';
import {
  countOf,
  dateRange,
  idOfReference,
  indexById,
  localDayRange,
  localToday,
  mrnOf,
  patientNames,
  resourcesOf,
  searchBundle,
} from '../fhir-utils';
import { addDays } from '../appointments/scheduling';
import { IntegrationService } from '../integration/integration.service';
import { PatientsService } from '../patients/patients.service';
import { ResultsService } from '../results/results.service';

const ACTIVITY_DAYS = 7;
const ENCOUNTER_WINDOW_LIMIT = 1000;
const ACTIVE_INPATIENT_LIMIT = 500;
const LIVE_APPOINTMENT_STATUSES = [
  'proposed',
  'pending',
  'booked',
  'arrived',
  'checked-in',
  'fulfilled',
];
const CRITICAL_CODES = ['LL', 'HH', 'AA'];

type Window = { start: string; end: string };

export type DayActivity = {
  date: string;
  admissions: number;
  discharges: number;
  opdVisits: number;
};

export type DashboardSummary = {
  generatedAt: string;
  date: string;
  kpis: {
    activeInpatients: number;
    opdVisitsToday: number;
    admissionsToday: number;
    dischargesToday: number;
    appointmentsToday: number;
    pendingOrders: number;
    criticalResultsToday: number;
    vitalsRecordedToday: number;
  };
  activity: DayActivity[];
  criticalAlerts: Awaited<ReturnType<ResultsService['critical']>>['items'];
  /** True when a window held more encounters than one page; counts are then lower bounds. */
  truncated: boolean;
};

export type RegistrationDashboard = {
  date: string;
  kpis: {
    opdVisits: number;
    admissions: number;
    discharges: number;
    appointments: number;
    cancellations: number;
    noShows: number;
  };
  events: {
    at: string;
    event: string;
    description: string;
    patientId: string | null;
    patientName: string | null;
    mrn: string | null;
  }[];
  truncated: boolean;
};

export type ClinicalDashboard = {
  date: string;
  kpis: {
    activeInpatients: number;
    ordersToday: number;
    pendingOrders: number;
    criticalResultsToday: number;
    averageLengthOfStayDays: number | null;
    vitalsRecordedToday: number;
  };
  inpatientsByWard: { ward: string; count: number }[];
};

function startedWithin(encounter: Encounter, window: Window): boolean {
  const start = encounter.period?.start;
  return !!start && start >= window.start && start < window.end;
}

function endedWithin(encounter: Encounter, window: Window): boolean {
  const end = encounter.period?.end;
  return !!end && end >= window.start && end < window.end;
}

/** What the day looked like, from the encounters that overlap it. */
function dayStats(encounters: Encounter[], window: Window) {
  let admissions = 0;
  let discharges = 0;
  let opdVisits = 0;
  let edVisits = 0;
  for (const encounter of encounters) {
    const code = encounter.class?.code;
    if (startedWithin(encounter, window)) {
      if (code === 'IMP') admissions += 1;
      else if (code === 'AMB') opdVisits += 1;
      else if (code === 'EMER') edVisits += 1;
    }
    if (
      code === 'IMP' &&
      encounter.status === 'finished' &&
      endedWithin(encounter, window)
    ) {
      discharges += 1;
    }
  }
  return { admissions, discharges, opdVisits, edVisits };
}

/**
 * Dashboard figures, computed from FHIR on request. The blueprint reads a
 * nightly `emr_dashboard_daily_summary` table instead; counting live keeps the
 * numbers current and avoids a second source of truth, at the cost of a fan-out
 * of searches per load.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly fhir: FhirAccess,
    private readonly patients: PatientsService,
    private readonly results: ResultsService,
    private readonly integration: IntegrationService,
  ) {}

  private today(now: Date): { date: string; window: Window } {
    const date = localToday(SCHEDULING.utcOffsetMinutes, now);
    return { date, window: localDayRange(date, SCHEDULING.utcOffsetMinutes) };
  }

  /** Encounters whose period overlaps the window (Medplum's `date` on a period). */
  private async encountersOverlapping(
    actor: MedplumActor,
    window: Window,
    include = false,
  ) {
    const bundle = await searchBundle(this.fhir.client(actor), 'Encounter', {
      date: dateRange(window.start, window.end),
      ...(include ? { _include: 'Encounter:subject' } : {}),
      _sort: '-date',
      _count: ENCOUNTER_WINDOW_LIMIT,
      _total: 'accurate',
    });
    const encounters = resourcesOf<Encounter>(bundle, 'Encounter');
    return {
      bundle,
      encounters,
      truncated: (bundle.total ?? encounters.length) > encounters.length,
    };
  }

  async summary(
    actor: MedplumActor,
    now = new Date(),
  ): Promise<DashboardSummary> {
    const client = this.fhir.client(actor);
    const { date, window } = this.today(now);
    const first = addDays(date, -(ACTIVITY_DAYS - 1));
    const span: Window = {
      start: localDayRange(first, SCHEDULING.utcOffsetMinutes).start,
      end: window.end,
    };

    const [
      week,
      activeInpatients,
      appointmentsToday,
      pendingOrders,
      criticalResultsToday,
      vitalsRecordedToday,
      alerts,
    ] = await Promise.all([
      this.encountersOverlapping(actor, span),
      countOf(client, 'Encounter', { class: 'IMP', status: 'in-progress' }),
      countOf(client, 'Appointment', {
        status: LIVE_APPOINTMENT_STATUSES,
        date: dateRange(window.start, window.end),
      }),
      countOf(client, 'ServiceRequest', { status: 'active' }),
      this.criticalToday(actor, window),
      this.vitalsToday(actor, window),
      this.results.critical({ limit: 5 }, actor, now),
    ]);

    const activity: DayActivity[] = [];
    for (let offset = 0; offset < ACTIVITY_DAYS; offset += 1) {
      const day = addDays(first, offset);
      const stats = dayStats(
        week.encounters,
        localDayRange(day, SCHEDULING.utcOffsetMinutes),
      );
      activity.push({
        date: day,
        admissions: stats.admissions,
        discharges: stats.discharges,
        opdVisits: stats.opdVisits,
      });
    }
    const todayStats = activity[activity.length - 1];

    return {
      generatedAt: now.toISOString(),
      date,
      kpis: {
        activeInpatients,
        opdVisitsToday: todayStats.opdVisits,
        admissionsToday: todayStats.admissions,
        dischargesToday: todayStats.discharges,
        appointmentsToday,
        pendingOrders,
        criticalResultsToday,
        vitalsRecordedToday,
      },
      activity,
      criticalAlerts: alerts.items,
      truncated: week.truncated,
    };
  }

  async registration(
    actor: MedplumActor,
    now = new Date(),
  ): Promise<RegistrationDashboard> {
    const client = this.fhir.client(actor);
    const { date, window } = this.today(now);
    const [day, appointments, cancelled, noShows] = await Promise.all([
      this.encountersOverlapping(actor, window, true),
      countOf(client, 'Appointment', {
        status: LIVE_APPOINTMENT_STATUSES,
        date: dateRange(window.start, window.end),
      }),
      searchBundle(client, 'Appointment', {
        status: 'cancelled',
        _lastUpdated: dateRange(window.start, window.end),
        _include: 'Appointment:actor',
        _sort: '-_lastUpdated',
        _count: 50,
      }),
      countOf(client, 'Appointment', {
        status: 'noshow',
        date: dateRange(window.start, window.end),
      }),
    ]);

    const stats = dayStats(day.encounters, window);
    const patients = indexById<Patient>(day.bundle, 'Patient');
    const who = (reference: string | undefined) => {
      const id = idOfReference(reference, 'Patient');
      const patient = id ? patients.get(id) : undefined;
      return {
        patientId: id ?? null,
        patientName: patient ? patientNames(patient).name : null,
        mrn: mrnOf(patient),
      };
    };

    const events: RegistrationDashboard['events'] = [];
    for (const encounter of day.encounters) {
      const view = toEncounterResponse(encounter);
      const person = who(encounter.subject?.reference);
      if (startedWithin(encounter, window)) {
        const inpatient = view.patientClass === 'IMP';
        events.push({
          at: encounter.period?.start ?? '',
          event: inpatient ? 'A01' : 'A04',
          description: inpatient
            ? `Admitted${view.locationDisplay ? ` to ${view.locationDisplay}` : ''}`
            : `Registered (${view.patientClass === 'EMER' ? 'ED' : 'OPD'})`,
          ...person,
        });
      }
      if (
        view.patientClass === 'IMP' &&
        encounter.status === 'finished' &&
        endedWithin(encounter, window)
      ) {
        events.push({
          at: encounter.period?.end ?? '',
          event: 'A03',
          description: 'Discharged',
          ...person,
        });
      }
    }
    const cancelledPatients = indexById<Patient>(cancelled, 'Patient');
    const cancelledAppointments = resourcesOf<Appointment>(
      cancelled,
      'Appointment',
    );
    for (const appointment of cancelledAppointments) {
      const reference = appointment.participant?.find((p) =>
        p.actor?.reference?.startsWith('Patient/'),
      )?.actor?.reference;
      const id = idOfReference(reference, 'Patient');
      const patient = id ? cancelledPatients.get(id) : undefined;
      events.push({
        at: appointment.meta?.lastUpdated ?? appointment.start ?? '',
        event: 'S14',
        description: 'Appointment cancelled',
        patientId: id ?? null,
        patientName: patient ? patientNames(patient).name : null,
        mrn: mrnOf(patient),
      });
    }
    events.sort((a, b) => b.at.localeCompare(a.at));

    return {
      date,
      kpis: {
        opdVisits: stats.opdVisits,
        admissions: stats.admissions,
        discharges: stats.discharges,
        appointments,
        cancellations: cancelledAppointments.length,
        noShows,
      },
      events: events.slice(0, 25),
      truncated: day.truncated,
    };
  }

  async clinical(
    actor: MedplumActor,
    now = new Date(),
  ): Promise<ClinicalDashboard> {
    const client = this.fhir.client(actor);
    const { date, window } = this.today(now);
    const [
      inpatients,
      ordersToday,
      pendingOrders,
      criticalResultsToday,
      vitalsRecordedToday,
    ] = await Promise.all([
      searchBundle(client, 'Encounter', {
        class: 'IMP',
        status: 'in-progress',
        _count: ACTIVE_INPATIENT_LIMIT,
        _total: 'accurate',
      }),
      countOf(client, 'ServiceRequest', {
        authored: dateRange(window.start, window.end),
      }),
      countOf(client, 'ServiceRequest', { status: 'active' }),
      this.criticalToday(actor, window),
      this.vitalsToday(actor, window),
    ]);

    const active = resourcesOf<Encounter>(inpatients, 'Encounter');
    const wards =
      active.length > 0 ? await this.patients.wardIndex(actor) : undefined;
    const perWard = new Map<string, number>();
    let stayDays = 0;
    let measured = 0;
    for (const encounter of active) {
      const view = toEncounterResponse(encounter);
      const ward = wards?.wardOf(view.locationId) ?? 'Unassigned';
      perWard.set(ward, (perWard.get(ward) ?? 0) + 1);
      const start = encounter.period?.start
        ? Date.parse(encounter.period.start)
        : Number.NaN;
      if (!Number.isNaN(start) && start <= now.getTime()) {
        stayDays += (now.getTime() - start) / 86_400_000;
        measured += 1;
      }
    }

    return {
      date,
      kpis: {
        activeInpatients: inpatients.total ?? active.length,
        ordersToday,
        pendingOrders,
        criticalResultsToday,
        averageLengthOfStayDays:
          measured === 0 ? null : Math.round((stayDays / measured) * 10) / 10,
        vitalsRecordedToday,
      },
      inpatientsByWard: [...perWard.entries()]
        .map(([ward, count]) => ({ ward, count }))
        .sort((a, b) => b.count - a.count || a.ward.localeCompare(b.ward)),
    };
  }

  /** IT administrators only; the controller checks the permission. */
  integrationStats(actor: MedplumActor, now = new Date()) {
    return this.integration.stats(actor.tenantId, now);
  }

  private criticalToday(actor: MedplumActor, window: Window): Promise<number> {
    return countOf(this.fhir.client(actor), 'Observation', {
      category: 'laboratory',
      interpretation: CRITICAL_CODES,
      date: dateRange(window.start, window.end),
    });
  }

  private vitalsToday(actor: MedplumActor, window: Window): Promise<number> {
    return countOf(this.fhir.client(actor), 'Observation', {
      category: 'vital-signs',
      date: dateRange(window.start, window.end),
    });
  }
}
