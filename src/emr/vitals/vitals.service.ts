import { BadRequestException, Injectable } from '@nestjs/common';
import type { Observation } from '@medplum/fhirtypes';
import { createEntry } from '../../fhir/fhir-transaction';
import type { MedplumActor } from '../../fhir/medplum-actor';
import { FhirAccess } from '../common/fhir-access';
import {
  ENTRY_SOURCE_SYSTEM,
  INTERPRETATION_SYSTEM,
  OBSERVATION_CATEGORY_SYSTEM,
} from '../emr.constants';
import {
  dateRange,
  entrySourceOf,
  idOfReference,
  referenceTo,
  resourcesOf,
  searchBundle,
} from '../fhir-utils';
import type {
  RecordVitalsDto,
  VitalRow,
  VitalsQueryDto,
  VitalsResponse,
} from './vitals.dto';
import {
  CRITICAL_SCAN_LIMIT,
  codingFor,
  flagOf,
  hasCriticalInterpretation,
  interpret,
  quantityFor,
  vitalByKey,
  vitalByLoinc,
} from './vitals.rules';

const DEFAULT_LIMIT = 100;
/** Clock skew allowed between the browser and this server. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Vital signs as LOINC-coded FHIR Observations (category `vital-signs`). */
@Injectable()
export class VitalsService {
  constructor(private readonly fhir: FhirAccess) {}

  async record(
    dto: RecordVitalsDto,
    actor: MedplumActor,
    now = new Date(),
  ): Promise<VitalsResponse> {
    const measuredAt = dto.measuredAt ? new Date(dto.measuredAt) : now;
    if (measuredAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
      throw new BadRequestException('Measurement time cannot be in the future');
    }

    const seen = new Set<string>();
    for (const reading of dto.readings) {
      const vital = vitalByKey(reading.code);
      if (!vital) {
        throw new BadRequestException(`Unknown vital sign ${reading.code}`);
      }
      if (seen.has(reading.code)) {
        throw new BadRequestException(`${vital.display} was entered twice`);
      }
      seen.add(reading.code);
      const { low, high } = vital.plausible;
      if (reading.value < low || reading.value > high) {
        throw new BadRequestException(
          `${vital.display} must be between ${low} and ${high} ${vital.unit}`,
        );
      }
    }

    await this.fhir.readPatient(dto.patientId, actor);
    if (dto.encounterId) {
      await this.fhir.readEncounterOf(dto.encounterId, dto.patientId, actor);
    }

    const performer = this.fhir.performerOf(actor);
    const observations = dto.readings.map((reading) => {
      const vital = vitalByKey(reading.code)!;
      const interpretation = interpret(vital, reading.value);
      const observation: Observation = {
        resourceType: 'Observation',
        status: 'final',
        category: [
          {
            coding: [
              {
                system: OBSERVATION_CATEGORY_SYSTEM,
                code: 'vital-signs',
                display: 'Vital Signs',
              },
            ],
          },
        ],
        code: { coding: [codingFor(vital)], text: vital.display },
        subject: referenceTo('Patient', dto.patientId),
        ...(dto.encounterId
          ? { encounter: referenceTo('Encounter', dto.encounterId) }
          : {}),
        ...(performer ? { performer: [performer] } : {}),
        effectiveDateTime: measuredAt.toISOString(),
        issued: now.toISOString(),
        valueQuantity: quantityFor(vital, reading.value),
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
        ...(dto.note ? { note: [{ text: dto.note }] } : {}),
        meta: {
          tag: [{ system: ENTRY_SOURCE_SYSTEM, code: dto.source ?? 'MANUAL' }],
        },
      };
      return observation;
    });

    const result = await this.fhir.commit(
      actor,
      observations.map((observation) => createEntry(observation)),
    );
    const created = (result.entry ?? []).flatMap((entry) =>
      entry.resource ? [entry.resource as Observation] : [],
    );
    return this.respond(created);
  }

  async list(
    query: VitalsQueryDto,
    actor: MedplumActor,
  ): Promise<VitalsResponse> {
    const bundle = await searchBundle(this.fhir.client(actor), 'Observation', {
      category: 'vital-signs',
      subject: query.patientId ? `Patient/${query.patientId}` : undefined,
      encounter: query.encounterId
        ? `Encounter/${query.encounterId}`
        : undefined,
      date: dateRange(query.from, query.to),
      _sort: '-date',
      _count: query.criticalOnly
        ? CRITICAL_SCAN_LIMIT
        : (query.limit ?? DEFAULT_LIMIT),
    });
    const observations = resourcesOf<Observation>(bundle, 'Observation');
    return this.respond(
      query.criticalOnly
        ? observations
            .filter(hasCriticalInterpretation)
            .slice(0, query.limit ?? DEFAULT_LIMIT)
        : observations,
    );
  }

  private respond(observations: Observation[]): VitalsResponse {
    const items = observations.map((observation) => this.toRow(observation));
    return {
      items,
      summary: {
        total: items.length,
        critical: items.filter((row) => row.flag === 'critical').length,
        abnormal: items.filter((row) => row.flag === 'abnormal').length,
      },
    };
  }

  private toRow(observation: Observation): VitalRow {
    const loinc = observation.code?.coding?.[0]?.code;
    const vital = vitalByLoinc(loinc);
    const interpretation =
      observation.interpretation?.[0]?.coding?.[0]?.code ?? null;
    return {
      id: observation.id ?? '',
      patientId:
        idOfReference(observation.subject?.reference, 'Patient') ?? null,
      encounterId:
        idOfReference(observation.encounter?.reference, 'Encounter') ?? null,
      code: vital?.key ?? loinc ?? 'UNKNOWN',
      loinc: loinc ?? '',
      display: vital?.display ?? observation.code?.text ?? loinc ?? 'Unknown',
      value: observation.valueQuantity?.value ?? Number.NaN,
      unit: observation.valueQuantity?.unit ?? vital?.unit ?? '',
      interpretation,
      flag: flagOf(interpretation ?? undefined),
      measuredAt: observation.effectiveDateTime ?? observation.issued ?? null,
      source: entrySourceOf(observation),
    };
  }
}
