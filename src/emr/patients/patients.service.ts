import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
} from '@nestjs/common';
import type {
  AllergyIntolerance,
  Encounter,
  Location,
  Observation,
  Patient,
  Practitioner,
} from '@medplum/fhirtypes';
import {
  IDENTIFIER_TYPE_SYSTEM,
  IQAMA_SYSTEM,
  LANGUAGE_EXTENSION_URL,
  MRN_SYSTEM,
  NATIONAL_ID_SYSTEM,
} from '../../fhir/fhir.constants';
import { toEncounterResponse } from '../../fhir/adt.mapper';
import { createEntry, resultAt, wasCreated } from '../../fhir/fhir-transaction';
import type { MedplumActor } from '../../fhir/medplum-actor';
import { FhirAccess } from '../common/fhir-access';
import { EmrEventBus } from '../emr-events';
import { ENTRY_SOURCE_SYSTEM } from '../emr.constants';
import {
  countOf,
  idOfReference,
  mobileOf,
  mrnOf,
  patientNames,
  resourcesOf,
  searchBundle,
  indexById,
  type SearchParams,
} from '../fhir-utils';
import { SequenceService } from '../sequence.service';
import { AppointmentsService } from '../appointments/appointments.service';
import { DiagnosesService } from '../diagnoses/diagnoses.service';
import { OrdersService } from '../orders/orders.service';
import { ResultsService } from '../results/results.service';
import { VitalsService } from '../vitals/vitals.service';
import {
  PHONE_PATTERN,
  type PatientClassCode,
  type RegisteredPatient,
  type RegisterPatientDto,
  type WorklistFilter,
  type WorklistItem,
  type WorklistQueryDto,
} from './patients.dto';
import { diffResources, type FieldChange } from './resource-diff';
import { WardIndex } from './ward-index';

const DEFAULT_LIMIT = 50;
const ACTIVE_ENCOUNTER_LIMIT = 200;
const CRITICAL_WINDOW_DAYS = 7;
const MAX_MRN_ATTEMPTS = 5;

const CLASS_OF_FILTER: Partial<Record<WorklistFilter, PatientClassCode>> = {
  inpatient: 'IMP',
  opd: 'AMB',
  ed: 'EMER',
};

/** When a patient has several open encounters, the sickest setting wins. */
const CLASS_RANK: Record<string, number> = { IMP: 0, EMER: 1, AMB: 2 };

export type PatientOverview = {
  patient: {
    id: string;
    mrn: string | null;
    name: string;
    nameAr: string | null;
    gender: string | null;
    birthDate: string | null;
    ageYears: number | null;
    mobile: string | null;
    email: string | null;
    nationalId: string | null;
    preferredLanguage: 'en' | 'ar';
    emergencyContact: {
      name: string;
      relationship: string | null;
      phone: string | null;
    } | null;
    allergies: string[];
    lastUpdated: string | null;
  };
  activeEncounter: ReturnType<typeof toEncounterResponse> | null;
  ward: string | null;
  diagnoses: Awaited<ReturnType<DiagnosesService['list']>>['items'];
  latestVitals: Awaited<ReturnType<VitalsService['list']>>['items'];
  upcomingAppointments: Awaited<
    ReturnType<AppointmentsService['list']>
  >['items'];
  recentActivity: ActivityItem[];
  counts: {
    encounters: number;
    orders: number;
    results: number;
    vitals: number;
    diagnoses: number;
    appointments: number;
  };
};

export type ActivityItem = {
  type:
    'encounter' | 'order' | 'result' | 'vitals' | 'diagnosis' | 'appointment';
  id: string;
  at: string;
  title: string;
  detail: string | null;
};

export type AuditVersion = {
  versionId: string;
  lastUpdated: string | null;
  author: string | null;
  /** `created` for the first version. */
  kind: 'created' | 'updated';
  changes: FieldChange[];
};

export type WorklistResult = {
  items: WorklistItem[];
  counts: Record<WorklistFilter, number>;
};

function ageOf(birthDate: string | undefined, now: Date): number | null {
  if (!birthDate) return null;
  const born = new Date(`${birthDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return null;
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < born.getUTCMonth() ||
    (now.getUTCMonth() === born.getUTCMonth() &&
      now.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : null;
}

/** `q` as the one FHIR search it most likely means. */
export function patientSearchParams(q: string | undefined): SearchParams {
  const text = (q ?? '').trim();
  if (!text) return {};
  if (PHONE_PATTERN.test(text)) return { phone: text };
  if (/^[A-Za-z0-9]+-\d+$/.test(text)) {
    return { identifier: `${MRN_SYSTEM}|${text.toUpperCase()}` };
  }
  return { name: text };
}

function matchesText(patient: Patient, q: string | undefined): boolean {
  const needle = (q ?? '').trim().toLowerCase();
  if (!needle) return true;
  const names = patientNames(patient);
  return [names.name, names.nameAr, mrnOf(patient), mobileOf(patient)].some(
    (value) => value?.toLowerCase().includes(needle),
  );
}

/** Patient registration, the working list, the chart overview and the audit trail. */
@Injectable()
export class PatientsService {
  constructor(
    private readonly fhir: FhirAccess,
    private readonly sequences: SequenceService,
    private readonly diagnoses: DiagnosesService,
    private readonly vitals: VitalsService,
    private readonly orders: OrdersService,
    private readonly results: ResultsService,
    private readonly appointments: AppointmentsService,
    @Optional() private readonly bus?: EmrEventBus,
  ) {}

  // ------------------------------------------------------------- worklist

  async list(
    query: WorklistQueryDto,
    actor: MedplumActor,
    now = new Date(),
  ): Promise<WorklistResult> {
    const client = this.fhir.client(actor);
    const filter = query.filter ?? 'all';
    const limit = query.limit ?? DEFAULT_LIMIT;
    const critical = await this.criticalPatientIds(actor, now);

    let patients: Patient[] = [];
    let encounters: Encounter[] | undefined;

    const classCode = CLASS_OF_FILTER[filter];
    if (classCode) {
      const bundle = await searchBundle(client, 'Encounter', {
        status: 'in-progress',
        class: classCode,
        _include: 'Encounter:subject',
        _sort: '-date',
        _count: ACTIVE_ENCOUNTER_LIMIT,
      });
      encounters = resourcesOf<Encounter>(bundle, 'Encounter');
      const included = indexById<Patient>(bundle, 'Patient');
      const seen = new Set<string>();
      for (const encounter of encounters) {
        const id = idOfReference(encounter.subject?.reference, 'Patient');
        const patient = id ? included.get(id) : undefined;
        if (patient?.id && !seen.has(patient.id)) {
          seen.add(patient.id);
          patients.push(patient);
        }
      }
      patients = patients.filter((patient) => matchesText(patient, query.q));
    } else if (filter === 'critical') {
      const ids = [...critical].slice(0, ACTIVE_ENCOUNTER_LIMIT);
      patients =
        ids.length === 0
          ? []
          : resourcesOf<Patient>(
              await searchBundle(client, 'Patient', {
                _id: ids,
                _count: ids.length,
              }),
              'Patient',
            ).filter((patient) => matchesText(patient, query.q));
    } else {
      patients = resourcesOf<Patient>(
        await searchBundle(client, 'Patient', {
          ...patientSearchParams(query.q),
          _sort: '-_lastUpdated',
          _count: limit,
        }),
        'Patient',
      );
    }
    patients = patients.slice(0, limit);

    const ids = patients.flatMap((patient) => (patient.id ? [patient.id] : []));
    if (!encounters || filter === 'critical') {
      encounters =
        ids.length === 0 ? [] : await this.activeEncounters(ids, actor);
    }
    const allergic = await this.patientsWithAllergies(ids, actor);

    const byPatient = new Map<string, Encounter>();
    for (const encounter of encounters) {
      const id = idOfReference(encounter.subject?.reference, 'Patient');
      if (!id) continue;
      const current = byPatient.get(id);
      const rank = (e: Encounter) => CLASS_RANK[e.class?.code ?? ''] ?? 9;
      if (!current || rank(encounter) < rank(current))
        byPatient.set(id, encounter);
    }

    const wards = byPatient.size > 0 ? await this.wardIndex(actor) : undefined;
    const items = patients.map((patient): WorklistItem => {
      const encounter = patient.id ? byPatient.get(patient.id) : undefined;
      const view = encounter ? toEncounterResponse(encounter) : undefined;
      const names = patientNames(patient);
      return {
        id: patient.id ?? '',
        mrn: mrnOf(patient),
        name: names.name,
        nameAr: names.nameAr,
        gender: patient.gender ?? null,
        birthDate: patient.birthDate ?? null,
        ageYears: ageOf(patient.birthDate, now),
        mobile: mobileOf(patient),
        patientClass: view?.patientClass ?? null,
        encounterId: view?.id ?? null,
        visitNumber: view?.visitNumber ?? null,
        ward: wards?.wardOf(view?.locationId) ?? null,
        location: view?.locationDisplay ?? null,
        lastActivity: view?.periodStart ?? patient.meta?.lastUpdated ?? null,
        critical: patient.id ? critical.has(patient.id) : false,
        hasAllergy: patient.id ? allergic.has(patient.id) : false,
      };
    });

    return { items, counts: await this.worklistCounts(actor, critical.size) };
  }

  private async worklistCounts(
    actor: MedplumActor,
    criticalPatients: number,
  ): Promise<Record<WorklistFilter, number>> {
    const client = this.fhir.client(actor);
    const active = (code: PatientClassCode) =>
      countOf(client, 'Encounter', { status: 'in-progress', class: code });
    const [all, inpatient, opd, ed] = await Promise.all([
      countOf(client, 'Patient', {}),
      active('IMP'),
      active('AMB'),
      active('EMER'),
    ]);
    return { all, inpatient, opd, ed, critical: criticalPatients };
  }

  /** Patients with a critical laboratory value in the last week. */
  private async criticalPatientIds(
    actor: MedplumActor,
    now: Date,
  ): Promise<Set<string>> {
    const from = new Date(now.getTime() - CRITICAL_WINDOW_DAYS * 86_400_000);
    const bundle = await searchBundle(this.fhir.client(actor), 'Observation', {
      category: 'laboratory',
      interpretation: ['LL', 'HH', 'AA'],
      date: `ge${from.toISOString()}`,
      _count: 200,
    });
    return new Set(
      resourcesOf<Observation>(bundle, 'Observation').flatMap((observation) => {
        const id = idOfReference(observation.subject?.reference, 'Patient');
        return id ? [id] : [];
      }),
    );
  }

  private async activeEncounters(
    patientIds: string[],
    actor: MedplumActor,
  ): Promise<Encounter[]> {
    const bundle = await searchBundle(this.fhir.client(actor), 'Encounter', {
      subject: patientIds.map((id) => `Patient/${id}`),
      status: 'in-progress',
      _sort: '-date',
      _count: ACTIVE_ENCOUNTER_LIMIT,
    });
    return resourcesOf<Encounter>(bundle, 'Encounter');
  }

  private async patientsWithAllergies(
    patientIds: string[],
    actor: MedplumActor,
  ): Promise<Set<string>> {
    if (patientIds.length === 0) return new Set();
    const bundle = await searchBundle(
      this.fhir.client(actor),
      'AllergyIntolerance',
      {
        patient: patientIds.map((id) => `Patient/${id}`),
        'clinical-status': 'active',
        _count: ACTIVE_ENCOUNTER_LIMIT,
      },
    );
    return new Set(
      resourcesOf<AllergyIntolerance>(bundle, 'AllergyIntolerance').flatMap(
        (allergy) => {
          const id = idOfReference(allergy.patient?.reference, 'Patient');
          return id ? [id] : [];
        },
      ),
    );
  }

  async wardIndex(actor: MedplumActor): Promise<WardIndex> {
    const bundle = await searchBundle(this.fhir.client(actor), 'Location', {
      status: 'active',
      _count: 200,
    });
    return new WardIndex(resourcesOf<Location>(bundle, 'Location'));
  }

  // ------------------------------------------------------------- overview

  async overview(
    id: string,
    actor: MedplumActor,
    now = new Date(),
  ): Promise<PatientOverview> {
    const patient = await this.fhir.readPatient(id, actor);
    const client = this.fhir.client(actor);
    const subject = `Patient/${id}`;

    const [
      encounters,
      diagnoses,
      vitals,
      orders,
      results,
      upcoming,
      allergies,
      counts,
    ] = await Promise.all([
      searchBundle(client, 'Encounter', {
        subject,
        _sort: '-date',
        _count: 5,
      }).then((bundle) => resourcesOf<Encounter>(bundle, 'Encounter')),
      this.diagnoses.list({ patientId: id, limit: 5 }, actor),
      this.vitals.list({ patientId: id, limit: 30 }, actor),
      this.orders.list({ patientId: id, limit: 5 }, actor),
      this.results.list({ patientId: id, limit: 5 }, actor),
      this.appointments.list(
        { patientId: id, from: now.toISOString(), limit: 5 },
        actor,
      ),
      this.patientAllergies(id, actor),
      this.overviewCounts(id, actor),
    ]);

    const active = encounters.find(
      (encounter) => encounter.status === 'in-progress',
    );
    const activeView = active ? toEncounterResponse(active) : null;
    const ward = activeView?.locationId
      ? (await this.wardIndex(actor)).wardOf(activeView.locationId)
      : null;

    // The newest reading of each vital, not the newest 30 readings.
    const latestVitals = [
      ...new Map(
        vitals.items.map((row) => [row.code, row] as const).reverse(),
      ).values(),
    ].sort((a, b) => (b.measuredAt ?? '').localeCompare(a.measuredAt ?? ''));

    const activity: ActivityItem[] = [
      ...encounters.map((encounter): ActivityItem => {
        const view = toEncounterResponse(encounter);
        return {
          type: 'encounter',
          id: view.id,
          at: view.periodStart ?? view.lastUpdated ?? '',
          title: `${view.patientClass} encounter ${view.status}`,
          detail: view.locationDisplay,
        };
      }),
      ...orders.items.map((row): ActivityItem => ({
        type: 'order',
        id: row.id,
        at: row.orderedAt ?? '',
        title: `Order ${row.orderNumber ?? ''} ${row.status}`.trim(),
        detail: row.display,
      })),
      ...results.items.map((row): ActivityItem => ({
        type: 'result',
        id: row.id,
        at: row.issuedAt ?? '',
        title: row.hasCritical ? 'Critical result' : 'Result',
        detail: row.display,
      })),
      ...vitals.items.slice(0, 5).map((row): ActivityItem => ({
        type: 'vitals',
        id: row.id,
        at: row.measuredAt ?? '',
        title: `${row.display} ${row.value} ${row.unit}`.trim(),
        detail: row.flag === 'normal' ? null : row.flag,
      })),
      ...diagnoses.items.map((row): ActivityItem => ({
        type: 'diagnosis',
        id: row.id,
        at: row.recordedAt ?? '',
        title: row.display ?? row.code ?? 'Diagnosis',
        detail: row.type,
      })),
    ]
      .filter((item) => item.at)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 8);

    const names = patientNames(patient);
    const contact = patient.contact?.[0];
    return {
      patient: {
        id,
        mrn: mrnOf(patient),
        name: names.name,
        nameAr: names.nameAr,
        gender: patient.gender ?? null,
        birthDate: patient.birthDate ?? null,
        ageYears: ageOf(patient.birthDate, now),
        mobile: mobileOf(patient),
        email:
          patient.telecom?.find((point) => point.system === 'email')?.value ??
          null,
        nationalId:
          patient.identifier?.find(
            (identifier) =>
              identifier.system === NATIONAL_ID_SYSTEM ||
              identifier.system === IQAMA_SYSTEM,
          )?.value ?? null,
        preferredLanguage: this.languageOf(patient),
        emergencyContact: contact
          ? {
              name:
                contact.name?.text ??
                [...(contact.name?.given ?? []), contact.name?.family]
                  .filter(Boolean)
                  .join(' '),
              relationship:
                contact.relationship?.[0]?.text ??
                contact.relationship?.[0]?.coding?.[0]?.display ??
                null,
              phone:
                contact.telecom?.find((point) => point.system === 'phone')
                  ?.value ?? null,
            }
          : null,
        allergies,
        lastUpdated: patient.meta?.lastUpdated ?? null,
      },
      activeEncounter: activeView,
      ward,
      diagnoses: diagnoses.items,
      latestVitals,
      upcomingAppointments: upcoming.items.filter(
        (row) => row.status !== 'cancelled' && row.status !== 'noshow',
      ),
      recentActivity: activity,
      counts,
    };
  }

  private languageOf(patient: Patient): 'en' | 'ar' {
    const preferred =
      patient.communication?.find((entry) => entry.preferred) ??
      patient.communication?.[0];
    return preferred?.language?.coding?.[0]?.code
      ?.toLowerCase()
      .startsWith('ar')
      ? 'ar'
      : 'en';
  }

  private async patientAllergies(
    id: string,
    actor: MedplumActor,
  ): Promise<string[]> {
    const bundle = await searchBundle(
      this.fhir.client(actor),
      'AllergyIntolerance',
      { patient: `Patient/${id}`, 'clinical-status': 'active', _count: 20 },
    );
    return resourcesOf<AllergyIntolerance>(
      bundle,
      'AllergyIntolerance',
    ).flatMap((allergy) => {
      const label =
        allergy.code?.text ?? allergy.code?.coding?.[0]?.display ?? undefined;
      return label ? [label] : [];
    });
  }

  private async overviewCounts(id: string, actor: MedplumActor) {
    const client = this.fhir.client(actor);
    const subject = `Patient/${id}`;
    const [encounters, orders, results, vitals, diagnoses, appointments] =
      await Promise.all([
        countOf(client, 'Encounter', { subject }),
        countOf(client, 'ServiceRequest', { subject }),
        countOf(client, 'DiagnosticReport', { subject }),
        countOf(client, 'Observation', { subject, category: 'vital-signs' }),
        countOf(client, 'Condition', {
          subject,
          category: 'encounter-diagnosis',
        }),
        countOf(client, 'Appointment', { patient: subject }),
      ]);
    return { encounters, orders, results, vitals, diagnoses, appointments };
  }

  // ----------------------------------------------------------- registration

  /**
   * Manual registration. The MRN is assigned here, never typed: a sequence
   * hands out the number and a conditional create refuses to store it if a
   * patient already carries it.
   */
  async register(
    dto: RegisterPatientDto,
    actor: MedplumActor,
    now = new Date(),
  ): Promise<RegisteredPatient> {
    this.validate(dto, now);
    const tenantCode = this.fhir.tenantCode(actor);

    if (dto.nationalId) {
      const existing = await this.findByNationalId(dto.nationalId, actor);
      if (existing) {
        throw new ConflictException(
          `A patient with this ID already exists (MRN ${mrnOf(existing) ?? existing.id})`,
        );
      }
    }

    for (let attempt = 0; attempt < MAX_MRN_ATTEMPTS; attempt += 1) {
      const number = await this.sequences.next(actor.tenantId, 'mrn');
      const mrn = `${tenantCode}-${String(number).padStart(5, '0')}`;
      const patient = this.buildPatient(dto, mrn);

      const bundle = await this.fhir.commit(actor, [
        createEntry(patient, `identifier=${MRN_SYSTEM}|${mrn}`),
      ]);
      if (!wasCreated(bundle, 0)) continue; // number already in use; take the next
      const created = resultAt<Patient>(bundle, 0);
      const id = created?.id ?? '';
      const names = patientNames(created ?? patient);

      this.bus?.publish({
        channel: 'emr.adt',
        event: 'A28',
        tenantId: actor.tenantId,
        actor,
        patientId: id,
        resource: `Patient/${id}`,
        data: { mrn },
      });
      return {
        id,
        mrn,
        name: names.name,
        nameAr: names.nameAr,
        entrySource: 'MANUAL',
      };
    }
    throw new ConflictException(
      'Could not assign a medical record number; please try again',
    );
  }

  private validate(dto: RegisterPatientDto, now: Date): void {
    const birth = new Date(`${dto.birthDate}T00:00:00Z`);
    if (
      Number.isNaN(birth.getTime()) ||
      birth.toISOString().slice(0, 10) !== dto.birthDate
    ) {
      throw new BadRequestException('birthDate is not a real date');
    }
    if (birth.getTime() > now.getTime()) {
      throw new BadRequestException('birthDate cannot be in the future');
    }
    if (birth.getUTCFullYear() < 1900) {
      throw new BadRequestException('birthDate is implausibly early');
    }
    if (!dto.firstName.trim() || !dto.lastName.trim()) {
      throw new BadRequestException('firstName and lastName cannot be blank');
    }
    if (Boolean(dto.firstNameAr?.trim()) !== Boolean(dto.lastNameAr?.trim())) {
      throw new BadRequestException('Give both Arabic names, or neither');
    }
  }

  private buildPatient(dto: RegisterPatientDto, mrn: string): Patient {
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    const firstAr = dto.firstNameAr?.trim();
    const lastAr = dto.lastNameAr?.trim();
    const language = dto.preferredLanguage ?? 'en';
    const nationalIdSystem = dto.nationalId?.startsWith('2')
      ? IQAMA_SYSTEM
      : NATIONAL_ID_SYSTEM;

    return {
      resourceType: 'Patient',
      active: true,
      identifier: [
        {
          use: 'usual',
          type: { coding: [{ system: IDENTIFIER_TYPE_SYSTEM, code: 'MR' }] },
          system: MRN_SYSTEM,
          value: mrn,
        },
        ...(dto.nationalId
          ? [{ system: nationalIdSystem, value: dto.nationalId }]
          : []),
      ],
      name: [
        { use: 'official', family: lastName, given: [firstName] },
        ...(firstAr && lastAr
          ? [
              {
                use: 'official' as const,
                text: `${firstAr} ${lastAr}`,
                family: lastAr,
                given: [firstAr],
                extension: [{ url: LANGUAGE_EXTENSION_URL, valueCode: 'ar' }],
              },
            ]
          : []),
      ],
      gender: dto.gender,
      birthDate: dto.birthDate,
      telecom: [
        ...(dto.mobile
          ? [
              {
                system: 'phone' as const,
                use: 'mobile' as const,
                value: dto.mobile,
              },
            ]
          : []),
        ...(dto.email ? [{ system: 'email' as const, value: dto.email }] : []),
      ],
      communication: [
        {
          language: {
            coding: [{ system: 'urn:ietf:bcp:47', code: language }],
          },
          preferred: true,
        },
      ],
      ...(dto.emergencyContact
        ? {
            contact: [
              {
                relationship: dto.emergencyContact.relationship
                  ? [{ text: dto.emergencyContact.relationship }]
                  : undefined,
                name: { text: dto.emergencyContact.name },
                telecom: [
                  {
                    system: 'phone' as const,
                    value: dto.emergencyContact.phone,
                  },
                ],
              },
            ],
          }
        : {}),
      meta: { tag: [{ system: ENTRY_SOURCE_SYSTEM, code: 'MANUAL' }] },
    };
  }

  private async findByNationalId(
    nationalId: string,
    actor: MedplumActor,
  ): Promise<Patient | undefined> {
    const system = nationalId.startsWith('2')
      ? IQAMA_SYSTEM
      : NATIONAL_ID_SYSTEM;
    // Tenant-wide: the same person must not be registered once per branch.
    const bundle = await searchBundle(this.fhir.tenantWide(actor), 'Patient', {
      identifier: `${system}|${nationalId}`,
      _count: 1,
    });
    return resourcesOf<Patient>(bundle, 'Patient')[0];
  }

  // ------------------------------------------------------------------ audit

  /** Every stored version of the patient, newest first, with what changed in each. */
  async audit(
    id: string,
    actor: MedplumActor,
  ): Promise<{
    patient: { id: string; mrn: string | null; name: string };
    versions: AuditVersion[];
  }> {
    const patient = await this.fhir.readPatient(id, actor);
    const client = this.fhir.client(actor);
    const history = await client.readHistory('Patient', id);
    // Medplum lists newest first; the diffs need oldest first.
    const chronological = resourcesOf<Patient>(history)
      .filter((resource) => resource.resourceType === 'Patient')
      .reverse();

    const authors = await this.authorNames(
      chronological.flatMap((version) =>
        version.meta?.author?.reference ? [version.meta.author.reference] : [],
      ),
      actor,
    );

    const versions = chronological.map((version, index): AuditVersion => {
      const reference = version.meta?.author?.reference;
      return {
        versionId: version.meta?.versionId ?? String(index + 1),
        lastUpdated: version.meta?.lastUpdated ?? null,
        author:
          (reference ? authors.get(reference) : undefined) ??
          version.meta?.author?.display ??
          reference ??
          null,
        kind: index === 0 ? 'created' : 'updated',
        changes: diffResources(
          index === 0 ? undefined : chronological[index - 1],
          version,
        ),
      };
    });

    return {
      patient: {
        id,
        mrn: mrnOf(patient),
        name: patientNames(patient).name,
      },
      versions: versions.reverse(),
    };
  }

  private async authorNames(
    references: string[],
    actor: MedplumActor,
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        references.flatMap((reference) => {
          const id = idOfReference(reference, 'Practitioner');
          return id ? [id] : [];
        }),
      ),
    ];
    const names = new Map<string, string>();
    if (ids.length === 0) return names;
    try {
      const bundle = await searchBundle(
        this.fhir.client(actor),
        'Practitioner',
        {
          _id: ids,
          _count: ids.length,
        },
      );
      for (const practitioner of resourcesOf<Practitioner>(
        bundle,
        'Practitioner',
      )) {
        const name = practitioner.name?.[0];
        const text =
          name?.text ??
          [...(name?.prefix ?? []), ...(name?.given ?? []), name?.family]
            .filter(Boolean)
            .join(' ');
        if (practitioner.id && text) {
          names.set(`Practitioner/${practitioner.id}`, text);
        }
      }
    } catch {
      // The trail is still useful with raw references.
    }
    return names;
  }
}
