import { Injectable, Optional } from '@nestjs/common';
import type {
  DiagnosticReport,
  Observation,
  Patient,
  ServiceRequest,
} from '@medplum/fhirtypes';
import { createEntry, updateEntry } from '../../fhir/fhir-transaction';
import { KeyedMutex } from '../../fhir/keyed-mutex';
import { systemActor, type MedplumActor } from '../../fhir/medplum-actor';
import { FhirAccess } from '../common/fhir-access';
import { ProcessingError } from '../common/processing-error';
import {
  ENTRY_SOURCE_SYSTEM,
  INTERPRETATION_SYSTEM,
  LOINC_SYSTEM,
  MESSAGE_CONTROL_SYSTEM,
  OBSERVATION_CATEGORY_SYSTEM,
  ORDER_NUMBER_SYSTEM,
  RESULT_FLAG_CRITICAL,
  RESULT_FLAG_SYSTEM,
  UCUM_SYSTEM,
} from '../emr.constants';
import { EmrEventBus } from '../emr-events';
import {
  dateRange,
  entrySourceOf,
  hasTag,
  idOfReference,
  indexById,
  mrnOf,
  patientNames,
  referenceTo,
  resourcesOf,
  searchBundle,
} from '../fhir-utils';
import {
  CRITICAL_SCAN_LIMIT,
  flagOf,
  hasCriticalInterpretation,
  isCriticalInterpretation,
} from '../vitals/vitals.rules';
import type {
  CriticalAlert,
  CriticalQueryDto,
  InboundObservation,
  InboundResult,
  ObservationRow,
  ResultDetail,
  ResultRow,
  ResultsQueryDto,
} from './results.dto';

const DEFAULT_LIMIT = 100;
const DEFAULT_CRITICAL_WINDOW_DAYS = 7;
const DIAGNOSTIC_SERVICE_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/v2-0074';

/** OBX-11 result status to FHIR Observation.status. */
const OBSERVATION_STATUS: Record<string, Observation['status']> = {
  F: 'final',
  C: 'corrected',
  P: 'preliminary',
  R: 'registered',
  W: 'entered-in-error',
  D: 'entered-in-error',
  X: 'cancelled',
};

/** OBX-8 abnormal flags this module understands, normalised. */
const FLAG_ALIASES: Record<string, string> = {
  N: 'N',
  L: 'L',
  H: 'H',
  LL: 'LL',
  HH: 'HH',
  A: 'A',
  AA: 'AA',
  '<': 'L',
  '>': 'H',
};

export function normalizeFlag(flag: string | undefined): string | undefined {
  return flag ? FLAG_ALIASES[flag.trim().toUpperCase()] : undefined;
}

/** Results (HL7 ORU) as FHIR DiagnosticReports and Observations. */
@Injectable()
export class ResultsService {
  private readonly writers = new KeyedMutex();

  constructor(
    private readonly fhir: FhirAccess,
    @Optional() private readonly bus?: EmrEventBus,
  ) {}

  async list(
    query: ResultsQueryDto,
    actor: MedplumActor,
  ): Promise<{ items: ResultRow[]; criticalCount: number }> {
    const client = this.fhir.client(actor);
    const bundle = await searchBundle(client, 'DiagnosticReport', {
      status: query.status,
      subject: query.patientId ? `Patient/${query.patientId}` : undefined,
      encounter: query.encounterId
        ? `Encounter/${query.encounterId}`
        : undefined,
      date: dateRange(query.from, query.to),
      _tag: query.criticalOnly
        ? `${RESULT_FLAG_SYSTEM}|${RESULT_FLAG_CRITICAL}`
        : undefined,
      _include: 'DiagnosticReport:subject',
      _sort: '-date',
      _count: query.limit ?? DEFAULT_LIMIT,
    });
    const patients = indexById<Patient>(bundle, 'Patient');
    const items = resourcesOf<DiagnosticReport>(bundle, 'DiagnosticReport').map(
      (report) => this.toRow(report, patients),
    );
    return {
      items,
      criticalCount: items.filter((row) => row.hasCritical).length,
    };
  }

  async get(id: string, actor: MedplumActor): Promise<ResultDetail> {
    const report = await this.fhir.read<DiagnosticReport>(
      'DiagnosticReport',
      id,
      actor,
    );
    const patientId = idOfReference(report.subject?.reference, 'Patient');
    const patient = patientId
      ? await this.fhir.readPatient(patientId, actor).catch(() => undefined)
      : undefined;

    const ids = (report.result ?? []).flatMap((reference) => {
      const observationId = idOfReference(reference.reference, 'Observation');
      return observationId ? [observationId] : [];
    });
    const observations: Observation[] = [];
    if (ids.length > 0) {
      const bundle = await searchBundle(
        this.fhir.client(actor),
        'Observation',
        {
          _id: ids,
          _count: ids.length,
        },
      );
      const byId = indexById<Observation>(bundle, 'Observation');
      for (const observationId of ids) {
        const observation = byId.get(observationId);
        if (observation) observations.push(observation);
      }
    }

    return {
      ...this.toRow(
        report,
        new Map(patient && patientId ? [[patientId, patient]] : []),
      ),
      observations: observations.map((observation) =>
        this.toObservationRow(observation),
      ),
    };
  }

  /** One alert per critical laboratory observation in the window, newest first. */
  async critical(
    query: CriticalQueryDto,
    actor: MedplumActor,
    now = new Date(),
  ): Promise<{ items: CriticalAlert[] }> {
    const from =
      query.from ??
      new Date(
        now.getTime() - DEFAULT_CRITICAL_WINDOW_DAYS * 24 * 60 * 60_000,
      ).toISOString();
    const client = this.fhir.client(actor);
    const bundle = await searchBundle(client, 'Observation', {
      category: 'laboratory',
      subject: query.patientId ? `Patient/${query.patientId}` : undefined,
      date: dateRange(from, query.to),
      _include: 'Observation:subject',
      _sort: '-date',
      _count: CRITICAL_SCAN_LIMIT,
    });
    const patients = indexById<Patient>(bundle, 'Patient');
    const observations = resourcesOf<Observation>(bundle, 'Observation')
      .filter(hasCriticalInterpretation)
      .slice(0, query.limit ?? DEFAULT_LIMIT);

    const reportIds = new Map<string, string>();
    if (observations.length > 0) {
      const reports = await searchBundle(client, 'DiagnosticReport', {
        result: observations.map((o) => `Observation/${o.id}`),
        _count: observations.length,
      });
      for (const report of resourcesOf<DiagnosticReport>(
        reports,
        'DiagnosticReport',
      )) {
        for (const reference of report.result ?? []) {
          if (reference.reference && report.id) {
            reportIds.set(reference.reference, report.id);
          }
        }
      }
    }

    return {
      items: observations.map((observation) => {
        const patientId = idOfReference(
          observation.subject?.reference,
          'Patient',
        );
        const patient = patientId ? patients.get(patientId) : undefined;
        return {
          ...this.toObservationRow(observation),
          patientId: patientId ?? null,
          patientName: patient ? patientNames(patient).name : null,
          mrn: mrnOf(patient),
          reportId: reportIds.get(`Observation/${observation.id}`) ?? null,
        };
      }),
    };
  }

  /**
   * Stores a parsed result as one DiagnosticReport with its Observations, and
   * completes the order it answers, in a single transaction.
   *
   * Redelivery of the same message (same control id) is acknowledged without
   * writing again. A result that names an order must name the right patient.
   */
  ingest(
    result: InboundResult,
    tenantId: string,
    now = new Date(),
  ): Promise<{ reportId: string; duplicate: boolean; critical: boolean }> {
    const actor = systemActor(tenantId);
    return this.writers.run(tenantId, async () => {
      const client = this.fhir.client(actor);

      const existing = resourcesOf<DiagnosticReport>(
        await searchBundle(client, 'DiagnosticReport', {
          identifier: `${MESSAGE_CONTROL_SYSTEM}|${result.controlId}`,
          _count: 1,
        }),
        'DiagnosticReport',
      )[0];
      if (existing?.id) {
        return {
          reportId: existing.id,
          duplicate: true,
          critical: hasTag(existing, RESULT_FLAG_SYSTEM, RESULT_FLAG_CRITICAL),
        };
      }

      if (result.observations.length === 0) {
        throw new ProcessingError(
          'NO_OBSERVATIONS',
          'The result has no OBX segments',
        );
      }
      await this.fhir.readPatient(result.patientId, actor).catch(() => {
        throw new ProcessingError(
          'PATIENT_NOT_FOUND',
          `Patient ${result.patientId} does not exist`,
        );
      });
      const order = result.orderNumber
        ? await this.findOrder(result.orderNumber, result.patientId, actor)
        : undefined;

      const issuedAt = result.issuedAt ?? now.toISOString();
      const encounter = order?.encounter;
      const observationEntries = result.observations.map((line) =>
        createEntry(this.toObservation(line, result, issuedAt, encounter)),
      );
      const interpretations = result.observations.map((line) =>
        normalizeFlag(line.flag),
      );
      const critical = interpretations.some(isCriticalInterpretation);
      const statuses = result.observations.map(
        (line) =>
          OBSERVATION_STATUS[(line.status ?? 'F').toUpperCase()] ?? 'final',
      );

      const report: DiagnosticReport = {
        resourceType: 'DiagnosticReport',
        identifier: [
          { system: MESSAGE_CONTROL_SYSTEM, value: result.controlId },
          ...(result.orderNumber
            ? [{ system: ORDER_NUMBER_SYSTEM, value: result.orderNumber }]
            : []),
        ],
        status: statuses.includes('corrected')
          ? 'corrected'
          : statuses.every((status) => status === 'final')
            ? 'final'
            : 'preliminary',
        category: [
          {
            coding: [{ system: DIAGNOSTIC_SERVICE_SYSTEM, code: result.type }],
          },
        ],
        code: {
          coding: [
            {
              system: LOINC_SYSTEM,
              code: result.code,
              display: result.display,
            },
          ],
          text: result.display,
        },
        subject: referenceTo('Patient', result.patientId),
        ...(encounter ? { encounter } : {}),
        ...(order?.id
          ? { basedOn: [referenceTo('ServiceRequest', order.id)] }
          : {}),
        effectiveDateTime: issuedAt,
        issued: issuedAt,
        result: observationEntries.map((entry) => ({
          reference: entry.fullUrl,
        })),
        ...(result.conclusion ? { conclusion: result.conclusion } : {}),
        meta: {
          tag: [
            { system: ENTRY_SOURCE_SYSTEM, code: result.source },
            ...(critical
              ? [{ system: RESULT_FLAG_SYSTEM, code: RESULT_FLAG_CRITICAL }]
              : []),
          ],
        },
      };

      const entries = [...observationEntries, createEntry(report)];
      if (order && ['draft', 'active', 'on-hold'].includes(order.status)) {
        entries.push(updateEntry({ ...order, status: 'completed' }));
      }
      const committed = await this.fhir.commit(
        actor,
        entries,
        'The order changed while its result was being stored.',
      );
      const stored = committed.entry?.[observationEntries.length]?.resource as
        DiagnosticReport | undefined;
      const reportId = stored?.id;
      if (!reportId)
        throw new Error('FHIR transaction did not return the report');

      this.bus?.publish({
        channel: 'emr.oru',
        event: 'R01',
        tenantId,
        actor,
        patientId: result.patientId,
        resource: `DiagnosticReport/${reportId}`,
        data: {
          critical,
          display: result.display,
          orderNumber: result.orderNumber,
        },
      });
      return { reportId, duplicate: false, critical };
    });
  }

  private async findOrder(
    orderNumber: string,
    patientId: string,
    actor: MedplumActor,
  ): Promise<ServiceRequest> {
    const order = resourcesOf<ServiceRequest>(
      await searchBundle(this.fhir.client(actor), 'ServiceRequest', {
        identifier: `${ORDER_NUMBER_SYSTEM}|${orderNumber}`,
        _count: 1,
      }),
      'ServiceRequest',
    )[0];
    if (!order) {
      throw new ProcessingError(
        'ORDER_NOT_FOUND',
        `No order ${orderNumber} exists`,
      );
    }
    if (idOfReference(order.subject?.reference, 'Patient') !== patientId) {
      throw new ProcessingError(
        'ORDER_PATIENT_MISMATCH',
        `Order ${orderNumber} belongs to a different patient`,
      );
    }
    if (order.status === 'revoked' || order.status === 'entered-in-error') {
      throw new ProcessingError(
        'ORDER_CANCELLED',
        `Order ${orderNumber} was cancelled`,
      );
    }
    return order;
  }

  private toObservation(
    line: InboundObservation,
    result: InboundResult,
    issuedAt: string,
    encounter: ServiceRequest['encounter'],
  ): Observation {
    const interpretation = normalizeFlag(line.flag);
    const numeric = Number(line.value);
    const isNumeric = line.value.trim() !== '' && Number.isFinite(numeric);
    return {
      resourceType: 'Observation',
      status: OBSERVATION_STATUS[(line.status ?? 'F').toUpperCase()] ?? 'final',
      category: [
        {
          coding: [
            {
              system: OBSERVATION_CATEGORY_SYSTEM,
              code: result.type === 'LAB' ? 'laboratory' : 'imaging',
            },
          ],
        },
      ],
      code: {
        coding: [
          { system: LOINC_SYSTEM, code: line.code, display: line.display },
        ],
        text: line.display,
      },
      subject: referenceTo('Patient', result.patientId),
      ...(encounter ? { encounter } : {}),
      effectiveDateTime: line.observedAt ?? issuedAt,
      issued: issuedAt,
      ...(isNumeric
        ? {
            valueQuantity: {
              value: numeric,
              ...(line.unit
                ? { unit: line.unit, system: UCUM_SYSTEM, code: line.unit }
                : {}),
            },
          }
        : { valueString: line.value }),
      ...(interpretation
        ? {
            interpretation: [
              {
                coding: [
                  { system: INTERPRETATION_SYSTEM, code: interpretation },
                ],
              },
            ],
          }
        : {}),
      ...(line.referenceRange
        ? { referenceRange: [{ text: line.referenceRange }] }
        : {}),
      meta: { tag: [{ system: ENTRY_SOURCE_SYSTEM, code: result.source }] },
    };
  }

  private toObservationRow(observation: Observation): ObservationRow {
    const coding = observation.code?.coding?.[0];
    const interpretation =
      observation.interpretation?.[0]?.coding?.[0]?.code ?? null;
    const quantity = observation.valueQuantity;
    return {
      id: observation.id ?? '',
      code: coding?.code ?? null,
      display: coding?.display ?? observation.code?.text ?? null,
      value:
        quantity?.value !== undefined
          ? String(quantity.value)
          : (observation.valueString ?? null),
      numericValue: quantity?.value ?? null,
      unit: quantity?.unit ?? null,
      referenceRange: observation.referenceRange?.[0]?.text ?? null,
      interpretation,
      flag: flagOf(interpretation ?? undefined),
      status: observation.status,
      corrected: observation.status === 'corrected',
      observedAt: observation.effectiveDateTime ?? observation.issued ?? null,
    };
  }

  private toRow(
    report: DiagnosticReport,
    patients: Map<string, Patient>,
  ): ResultRow {
    const patientId = idOfReference(report.subject?.reference, 'Patient');
    const patient = patientId ? patients.get(patientId) : undefined;
    const coding = report.code?.coding?.[0];
    return {
      id: report.id ?? '',
      controlId:
        report.identifier?.find((id) => id.system === MESSAGE_CONTROL_SYSTEM)
          ?.value ?? null,
      orderNumber:
        report.identifier?.find((id) => id.system === ORDER_NUMBER_SYSTEM)
          ?.value ?? null,
      type: report.category?.[0]?.coding?.[0]?.code ?? null,
      code: coding?.code ?? null,
      display: coding?.display ?? report.code?.text ?? null,
      status: report.status,
      hasCritical: hasTag(report, RESULT_FLAG_SYSTEM, RESULT_FLAG_CRITICAL),
      patientId: patientId ?? null,
      patientName: patient ? patientNames(patient).name : null,
      mrn: mrnOf(patient),
      encounterId:
        idOfReference(report.encounter?.reference, 'Encounter') ?? null,
      issuedAt: report.issued ?? report.effectiveDateTime ?? null,
      conclusion: report.conclusion ?? null,
      source: entrySourceOf(report),
    };
  }
}
