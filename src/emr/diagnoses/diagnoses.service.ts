import { Injectable } from '@nestjs/common';
import type { Condition } from '@medplum/fhirtypes';
import { ICD10_SYSTEM } from '../../fhir/fhir.constants';
import type { MedplumActor } from '../../fhir/medplum-actor';
import { FhirAccess } from '../common/fhir-access';
import {
  CONDITION_CATEGORY_SYSTEM,
  CONDITION_CLINICAL_SYSTEM,
  CONDITION_VERIFICATION_SYSTEM,
  DIAGNOSIS_TYPE_SYSTEM,
} from '../emr.constants';
import {
  dateRange,
  idOfReference,
  referenceTo,
  resourcesOf,
  searchBundle,
} from '../fhir-utils';
import {
  DIAGNOSIS_TYPES,
  type CreateDiagnosisDto,
  type DiagnosesQueryDto,
  type DiagnosisRow,
  type DiagnosisType,
} from './diagnoses.dto';

const DEFAULT_LIMIT = 100;

/** Working and admitting diagnoses are provisional; the rest are confirmed. */
const PROVISIONAL: readonly DiagnosisType[] = ['WORKING', 'ADMITTING'];

/** Encounter diagnoses as FHIR Condition resources. */
@Injectable()
export class DiagnosesService {
  constructor(private readonly fhir: FhirAccess) {}

  async create(
    dto: CreateDiagnosisDto,
    actor: MedplumActor,
    now = new Date(),
  ): Promise<DiagnosisRow> {
    await this.fhir.readPatient(dto.patientId, actor);
    await this.fhir.readEncounterOf(dto.encounterId, dto.patientId, actor);

    const code = dto.code.toUpperCase();
    const recorder = this.fhir.performerOf(actor);
    const condition: Condition = {
      resourceType: 'Condition',
      clinicalStatus: {
        coding: [{ system: CONDITION_CLINICAL_SYSTEM, code: 'active' }],
      },
      verificationStatus: {
        coding: [
          {
            system: CONDITION_VERIFICATION_SYSTEM,
            code: PROVISIONAL.includes(dto.type) ? 'provisional' : 'confirmed',
          },
        ],
      },
      category: [
        {
          coding: [
            {
              system: CONDITION_CATEGORY_SYSTEM,
              code: 'encounter-diagnosis',
              display: 'Encounter Diagnosis',
            },
          ],
        },
        { coding: [{ system: DIAGNOSIS_TYPE_SYSTEM, code: dto.type }] },
      ],
      code: {
        coding: [{ system: ICD10_SYSTEM, code, display: dto.display }],
        text: dto.display,
      },
      subject: referenceTo('Patient', dto.patientId),
      encounter: referenceTo('Encounter', dto.encounterId),
      recordedDate: now.toISOString(),
      ...(recorder ? { recorder } : {}),
      ...(dto.notes ? { note: [{ text: dto.notes }] } : {}),
    };

    const created = await this.fhir.client(actor).createResource(condition);
    return this.toRow(created);
  }

  async list(
    query: DiagnosesQueryDto,
    actor: MedplumActor,
  ): Promise<{ items: DiagnosisRow[] }> {
    const bundle = await searchBundle(this.fhir.client(actor), 'Condition', {
      category: 'encounter-diagnosis',
      subject: query.patientId ? `Patient/${query.patientId}` : undefined,
      encounter: query.encounterId
        ? `Encounter/${query.encounterId}`
        : undefined,
      'recorded-date': dateRange(query.from, query.to),
      _sort: '-recorded-date',
      _count: query.limit ?? DEFAULT_LIMIT,
    });
    let rows = resourcesOf<Condition>(bundle, 'Condition').map((condition) =>
      this.toRow(condition),
    );
    if (query.type) rows = rows.filter((row) => row.type === query.type);
    return { items: rows };
  }

  private toRow(condition: Condition): DiagnosisRow {
    const typeCode = condition.category
      ?.flatMap((category) => category.coding ?? [])
      .find((coding) => coding.system === DIAGNOSIS_TYPE_SYSTEM)?.code;
    const coding = condition.code?.coding?.[0];
    return {
      id: condition.id ?? '',
      patientId: idOfReference(condition.subject?.reference, 'Patient') ?? null,
      encounterId:
        idOfReference(condition.encounter?.reference, 'Encounter') ?? null,
      type: DIAGNOSIS_TYPES.find((type) => type === typeCode) ?? null,
      code: coding?.code ?? null,
      display: coding?.display ?? condition.code?.text ?? null,
      verification: condition.verificationStatus?.coding?.[0]?.code ?? null,
      notes: condition.note?.[0]?.text ?? null,
      recordedAt: condition.recordedDate ?? null,
    };
  }
}
