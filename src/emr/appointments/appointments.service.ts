import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Appointment, Patient, Practitioner } from '@medplum/fhirtypes';
import {
  createEntry,
  resultAt,
  updateEntry,
  wasCreated,
} from '../../fhir/fhir-transaction';
import { KeyedMutex } from '../../fhir/keyed-mutex';
import { systemActor, type MedplumActor } from '../../fhir/medplum-actor';
import { FhirAccess } from '../common/fhir-access';
import { ProcessingError } from '../common/processing-error';
import {
  APPOINTMENT_SLOT_SYSTEM,
  APPOINTMENT_TYPE_SYSTEM,
  ENTRY_SOURCE_SYSTEM,
  EXTERNAL_APPOINTMENT_SYSTEM,
  SCH_EVENT_SYSTEM,
  SCHEDULING,
  type EntrySource,
} from '../emr.constants';
import { EmrEventBus } from '../emr-events';
import {
  dateRange,
  idOfReference,
  indexById,
  mrnOf,
  patientNames,
  referenceTo,
  resourcesOf,
  searchBundle,
  withTag,
} from '../fhir-utils';
import type {
  AppointmentRow,
  AppointmentsQueryDto,
  AppointmentTypeCode,
  BookAppointmentDto,
  SlotsQueryDto,
} from './appointments.dto';
import {
  addDays,
  bookingProblem,
  buildDaySlots,
  localMidnight,
  overlaps,
  type DaySlots,
  type Interval,
} from './scheduling';

const DEFAULT_LIMIT = 100;
const MINUTE_MS = 60_000;
/** Longest bookable appointment, used to bound the overlap search. */
const MAX_DURATION_MINUTES = 240;
/** Statuses that hold a slot. Cancelled and no-show appointments free it. */
const HOLDING_STATUSES = [
  'booked',
  'pending',
  'proposed',
  'arrived',
  'checked-in',
  'fulfilled',
];

/** An appointment booked by an external scheduler (HL7 SIU^S12). */
export type InboundBooking = {
  externalId: string;
  patientId: string;
  practitionerId: string;
  start: string;
  durationMinutes: number;
  reason?: string;
};

/** Scheduling (HL7 SIU) as FHIR Appointments over a computed 30-minute grid. */
@Injectable()
export class AppointmentsService {
  private readonly writers = new KeyedMutex();

  constructor(
    private readonly fhir: FhirAccess,
    @Optional() private readonly bus?: EmrEventBus,
  ) {}

  /** The weekly grid for one provider: free, booked or blocked per slot. */
  async slots(
    query: SlotsQueryDto,
    actor: MedplumActor,
    now = Date.now(),
  ): Promise<{ days: DaySlots[] }> {
    await this.fhir.read<Practitioner>(
      'Practitioner',
      query.practitionerId,
      actor,
    );
    const dayCount = query.days ?? 7;
    const rangeStart = localMidnight(query.from);
    const rangeEnd = localMidnight(addDays(query.from, dayCount));
    const busy = await this.busyIntervals(
      query.practitionerId,
      rangeStart,
      rangeEnd,
      actor,
    );
    return {
      days: Array.from({ length: dayCount }, (_, index) =>
        buildDaySlots(addDays(query.from, index), busy, now),
      ),
    };
  }

  async list(
    query: AppointmentsQueryDto,
    actor: MedplumActor,
  ): Promise<{ items: AppointmentRow[] }> {
    const bundle = await searchBundle(this.fhir.client(actor), 'Appointment', {
      status: query.status,
      patient: query.patientId ? `Patient/${query.patientId}` : undefined,
      practitioner: query.practitionerId
        ? `Practitioner/${query.practitionerId}`
        : undefined,
      date: dateRange(query.from, query.to),
      _include: 'Appointment:actor',
      _sort: 'date',
      _count: query.limit ?? DEFAULT_LIMIT,
    });
    const patients = indexById<Patient>(bundle, 'Patient');
    const practitioners = indexById<Practitioner>(bundle, 'Practitioner');
    return {
      items: resourcesOf<Appointment>(bundle, 'Appointment').map(
        (appointment) => this.toRow(appointment, patients, practitioners),
      ),
    };
  }

  /** Practitioners that can be booked, for the provider picker. */
  async providers(
    actor: MedplumActor,
  ): Promise<{ items: { id: string; name: string }[] }> {
    const bundle = await searchBundle(this.fhir.client(actor), 'Practitioner', {
      _count: 200,
    });
    const items = resourcesOf<Practitioner>(bundle, 'Practitioner').flatMap(
      (practitioner) => {
        if (!practitioner.id) return [];
        const name = practitioner.name?.[0];
        const text =
          name?.text ??
          [...(name?.prefix ?? []), ...(name?.given ?? []), name?.family]
            .filter(Boolean)
            .join(' ');
        return [{ id: practitioner.id, name: text || practitioner.id }];
      },
    );
    return { items: items.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /** S12: book a slot. */
  book(
    dto: BookAppointmentDto,
    actor: MedplumActor,
    now = new Date(),
  ): Promise<AppointmentRow> {
    return this.create(
      {
        patientId: dto.patientId,
        practitionerId: dto.practitionerId,
        start: dto.start,
        durationMinutes: dto.durationMinutes ?? SCHEDULING.slotMinutes,
        type: dto.type ?? 'ROUTINE',
        reason: dto.reason,
        source: 'MANUAL',
      },
      actor,
      now,
    );
  }

  /** S12 from an external scheduler. Redelivery of the same booking is a no-op. */
  async bookInbound(
    booking: InboundBooking,
    tenantId: string,
    now = new Date(),
  ): Promise<{ appointmentId: string; duplicate: boolean }> {
    const actor = systemActor(tenantId);
    const existing = await this.findExternal(booking.externalId, actor);
    if (existing?.id) {
      return { appointmentId: existing.id, duplicate: true };
    }
    try {
      const row = await this.create(
        {
          patientId: booking.patientId,
          practitionerId: booking.practitionerId,
          start: booking.start,
          durationMinutes: booking.durationMinutes,
          type: 'ROUTINE',
          reason: booking.reason,
          source: 'HL7',
          externalId: booking.externalId,
          allowPast: true,
        },
        actor,
        now,
      );
      return { appointmentId: row.id, duplicate: false };
    } catch (error) {
      throw this.asProcessingError(error);
    }
  }

  /** S14 / S15 from an external scheduler. */
  async cancelInbound(
    externalId: string,
    reason: string,
    tenantId: string,
  ): Promise<{ appointmentId: string; duplicate: boolean }> {
    const actor = systemActor(tenantId);
    const appointment = await this.findExternal(externalId, actor);
    if (!appointment?.id) {
      throw new ProcessingError(
        'APPOINTMENT_NOT_FOUND',
        `No appointment with external id ${externalId} exists`,
      );
    }
    if (appointment.status === 'cancelled') {
      return { appointmentId: appointment.id, duplicate: true };
    }
    try {
      await this.cancel(appointment.id, reason, actor);
      return { appointmentId: appointment.id, duplicate: false };
    } catch (error) {
      throw this.asProcessingError(error);
    }
  }

  /** S14: cancel with a reason. */
  cancel(
    id: string,
    reason: string,
    actor: MedplumActor,
  ): Promise<AppointmentRow> {
    return this.writers.run(actor.tenantId, async () => {
      const appointment = await this.fhir.read<Appointment>(
        'Appointment',
        id,
        actor,
      );
      if (appointment.status !== 'booked' && appointment.status !== 'pending') {
        throw new BadRequestException(
          `A ${appointment.status} appointment cannot be cancelled`,
        );
      }
      const cancelled: Appointment = {
        ...appointment,
        status: 'cancelled',
        cancelationReason: { text: reason },
        meta: {
          ...appointment.meta,
          tag: withTag(appointment, SCH_EVENT_SYSTEM, 'S14'),
        },
      };
      const result = await this.fhir.commit(
        actor,
        [updateEntry(cancelled)],
        'The appointment changed while it was being cancelled. Reload and try again.',
      );
      const saved = resultAt<Appointment>(result, 0) ?? cancelled;
      const row = await this.rowFor(saved, actor);
      this.publish('S14', actor, saved, {
        reason,
        start: saved.start,
        practitioner: row.practitionerName,
      });
      return row;
    });
  }

  /** Marks a booked appointment whose time has passed as a no-show. */
  noShow(
    id: string,
    actor: MedplumActor,
    now = new Date(),
  ): Promise<AppointmentRow> {
    return this.writers.run(actor.tenantId, async () => {
      const appointment = await this.fhir.read<Appointment>(
        'Appointment',
        id,
        actor,
      );
      if (appointment.status !== 'booked') {
        throw new BadRequestException(
          `A ${appointment.status} appointment cannot be marked as a no-show`,
        );
      }
      if (!appointment.start || Date.parse(appointment.start) > now.getTime()) {
        throw new BadRequestException(
          'An appointment that has not started yet cannot be a no-show',
        );
      }
      const result = await this.fhir.commit(actor, [
        updateEntry({ ...appointment, status: 'noshow' }),
      ]);
      return this.rowFor(
        resultAt<Appointment>(result, 0) ?? appointment,
        actor,
      );
    });
  }

  private async create(
    input: {
      patientId: string;
      practitionerId: string;
      start: string;
      durationMinutes: number;
      type: AppointmentTypeCode;
      reason?: string;
      source: EntrySource;
      externalId?: string;
      allowPast?: boolean;
    },
    actor: MedplumActor,
    now: Date,
  ): Promise<AppointmentRow> {
    const startMs = Date.parse(input.start);
    const problem = bookingProblem(startMs, input.durationMinutes);
    if (problem) throw new BadRequestException(problem);
    if (!input.allowPast && startMs <= now.getTime()) {
      throw new BadRequestException(
        'Appointments must be booked in the future',
      );
    }
    const endMs = startMs + input.durationMinutes * MINUTE_MS;

    return this.writers.run(actor.tenantId, async () => {
      const patient = await this.fhir.readPatient(input.patientId, actor);
      const practitioner = await this.fhir.read<Practitioner>(
        'Practitioner',
        input.practitionerId,
        actor,
      );

      const busy = await this.busyIntervals(
        input.practitionerId,
        startMs,
        endMs,
        actor,
      );
      if (
        busy.some((interval) =>
          overlaps(interval, { start: startMs, end: endMs }),
        )
      ) {
        throw new ConflictException('That time is no longer available');
      }

      const slotKey = `${input.practitionerId}@${new Date(startMs).toISOString()}`;
      const appointment: Appointment = {
        resourceType: 'Appointment',
        status: 'booked',
        identifier: [
          { system: APPOINTMENT_SLOT_SYSTEM, value: slotKey },
          ...(input.externalId
            ? [{ system: EXTERNAL_APPOINTMENT_SYSTEM, value: input.externalId }]
            : []),
        ],
        appointmentType: {
          coding: [{ system: APPOINTMENT_TYPE_SYSTEM, code: input.type }],
        },
        ...(input.reason ? { reasonCode: [{ text: input.reason }] } : {}),
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        minutesDuration: input.durationMinutes,
        created: now.toISOString(),
        participant: [
          {
            actor: referenceTo('Patient', input.patientId),
            status: 'accepted',
          },
          {
            actor: referenceTo('Practitioner', input.practitionerId),
            status: 'accepted',
          },
        ],
        meta: {
          tag: [
            { system: SCH_EVENT_SYSTEM, code: 'S12' },
            { system: ENTRY_SOURCE_SYSTEM, code: input.source },
          ],
        },
      };

      // A second API instance can pass the check above at the same moment;
      // the conditional create refuses the same provider and start time.
      const result = await this.fhir.commit(actor, [
        createEntry(
          appointment,
          `identifier=${APPOINTMENT_SLOT_SYSTEM}|${slotKey}&status=booked`,
        ),
      ]);
      if (!wasCreated(result, 0)) {
        throw new ConflictException('That time is no longer available');
      }
      const saved = resultAt<Appointment>(result, 0) ?? appointment;
      const row = this.toRow(
        saved,
        new Map(patient.id ? [[patient.id, patient]] : []),
        new Map(practitioner.id ? [[practitioner.id, practitioner]] : []),
      );
      this.publish('S12', actor, saved, {
        start: saved.start,
        practitioner: row.practitionerName,
        reason: input.reason,
      });
      return row;
    });
  }

  /**
   * Intervals a provider is already committed to, across the whole tenant
   * (not just the caller's branch), so a hidden booking still blocks the slot.
   */
  private async busyIntervals(
    practitionerId: string,
    fromMs: number,
    toMs: number,
    actor: MedplumActor,
  ): Promise<Interval[]> {
    const lookBehind = new Date(
      fromMs - MAX_DURATION_MINUTES * MINUTE_MS,
    ).toISOString();
    const bundle = await searchBundle(
      this.fhir.tenantWide(actor),
      'Appointment',
      {
        practitioner: `Practitioner/${practitionerId}`,
        status: HOLDING_STATUSES,
        date: dateRange(lookBehind, new Date(toMs).toISOString()),
        _count: 500,
      },
    );
    return resourcesOf<Appointment>(bundle, 'Appointment').flatMap(
      (appointment) => {
        if (!appointment.start) return [];
        const start = Date.parse(appointment.start);
        const end = appointment.end
          ? Date.parse(appointment.end)
          : start +
            (appointment.minutesDuration ?? SCHEDULING.slotMinutes) * MINUTE_MS;
        return [{ start, end }];
      },
    );
  }

  private async findExternal(
    externalId: string,
    actor: MedplumActor,
  ): Promise<Appointment | undefined> {
    return resourcesOf<Appointment>(
      await searchBundle(this.fhir.client(actor), 'Appointment', {
        identifier: `${EXTERNAL_APPOINTMENT_SYSTEM}|${externalId}`,
        _count: 1,
      }),
      'Appointment',
    )[0];
  }

  private asProcessingError(error: unknown): unknown {
    if (error instanceof ProcessingError) return error;
    if (error instanceof ConflictException) {
      return new ProcessingError('SLOT_UNAVAILABLE', error.message);
    }
    if (error instanceof BadRequestException) {
      return new ProcessingError('INVALID_APPOINTMENT', error.message);
    }
    if (error instanceof NotFoundException) {
      return new ProcessingError('REFERENCE_NOT_FOUND', error.message);
    }
    return error;
  }

  private publish(
    event: 'S12' | 'S14',
    actor: MedplumActor,
    appointment: Appointment,
    data: Record<string, unknown>,
  ): void {
    this.bus?.publish({
      channel: 'emr.sch',
      event,
      tenantId: actor.tenantId,
      actor,
      patientId: this.patientIdOf(appointment),
      resource: `Appointment/${appointment.id}`,
      data,
    });
  }

  private patientIdOf(appointment: Appointment): string | undefined {
    for (const participant of appointment.participant) {
      const id = idOfReference(participant.actor?.reference, 'Patient');
      if (id) return id;
    }
    return undefined;
  }

  private async rowFor(
    appointment: Appointment,
    actor: MedplumActor,
  ): Promise<AppointmentRow> {
    const patients = new Map<string, Patient>();
    const practitioners = new Map<string, Practitioner>();
    for (const participant of appointment.participant) {
      const patientId = idOfReference(participant.actor?.reference, 'Patient');
      const practitionerId = idOfReference(
        participant.actor?.reference,
        'Practitioner',
      );
      if (patientId) {
        const patient = await this.fhir
          .readPatient(patientId, actor)
          .catch(() => undefined);
        if (patient) patients.set(patientId, patient);
      }
      if (practitionerId) {
        const practitioner = await this.fhir
          .read<Practitioner>('Practitioner', practitionerId, actor)
          .catch(() => undefined);
        if (practitioner) practitioners.set(practitionerId, practitioner);
      }
    }
    return this.toRow(appointment, patients, practitioners);
  }

  private toRow(
    appointment: Appointment,
    patients: Map<string, Patient>,
    practitioners: Map<string, Practitioner>,
  ): AppointmentRow {
    const patientId = this.patientIdOf(appointment);
    const practitionerId = appointment.participant
      .map((participant) =>
        idOfReference(participant.actor?.reference, 'Practitioner'),
      )
      .find(Boolean);
    const patient = patientId ? patients.get(patientId) : undefined;
    const practitioner = practitionerId
      ? practitioners.get(practitionerId)
      : undefined;
    const practitionerName = practitioner?.name?.[0]
      ? (practitioner.name[0].text ??
        [...(practitioner.name[0].given ?? []), practitioner.name[0].family]
          .filter(Boolean)
          .join(' '))
      : null;

    return {
      id: appointment.id ?? '',
      status: appointment.status,
      start: appointment.start ?? null,
      end: appointment.end ?? null,
      durationMinutes: appointment.minutesDuration ?? null,
      type: appointment.appointmentType?.coding?.[0]?.code ?? null,
      reason: appointment.reasonCode?.[0]?.text ?? null,
      patientId: patientId ?? null,
      patientName: patient ? patientNames(patient).name : null,
      mrn: mrnOf(patient),
      practitionerId: practitionerId ?? null,
      practitionerName: practitionerName || null,
      cancellationReason: appointment.cancelationReason?.text ?? null,
      createdAt: appointment.created ?? null,
    };
  }
}
