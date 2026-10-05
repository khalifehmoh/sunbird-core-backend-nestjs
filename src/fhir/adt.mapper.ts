import type {
  Coding,
  Encounter,
  EncounterLocation,
  Location,
  Organization,
  Reference,
} from '@medplum/fhirtypes';
import {
  ADMIT_SOURCE_SYSTEM,
  ADT_EVENT_SYSTEM,
  DISCHARGE_DISPOSITION_SYSTEM,
  ENCOUNTER_CLASS_SYSTEM,
  ICD10_SYSTEM,
  LOCATION_CODE_SYSTEM,
  LOCATION_PHYSICAL_TYPE_SYSTEM,
  LOCATION_STATUS_SYSTEM,
  PARTICIPANT_TYPE_SYSTEM,
  VISIT_NUMBER_SYSTEM,
} from './fhir.constants';
import type {
  AdmitRequestDto,
  DischargeRequestDto,
  EncounterResponseDto,
  LocationNodeDto,
  PatientClass,
  PreadmitRequestDto,
  RegisterVisitRequestDto,
  TransferRequestDto,
} from './dto/adt.dto';

const CLASS_DISPLAY: Record<PatientClass, string> = {
  IMP: 'inpatient encounter',
  AMB: 'ambulatory',
  EMER: 'emergency',
};

const ADMIT_TYPE_DISPLAY: Record<string, string> = {
  routine: 'Routine',
  urgent: 'Urgent',
  elective: 'Elective',
  emergency: 'Emergency',
};

export function encounterClass(code: PatientClass): Coding {
  return {
    system: ENCOUNTER_CLASS_SYSTEM,
    code,
    display: CLASS_DISPLAY[code],
  };
}

export function visitIdentifier(visitNumber: string) {
  return {
    use: 'usual' as const,
    type: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
          code: 'VN',
          display: 'Visit number',
        },
      ],
    },
    system: VISIT_NUMBER_SYSTEM,
    value: visitNumber,
  };
}

export function adtEventTag(event: string): Coding {
  return { system: ADT_EVENT_SYSTEM, code: event };
}

export function attendingParticipant(
  practitionerId: string,
  display?: string,
): NonNullable<Encounter['participant']>[number] {
  return {
    type: [
      {
        coding: [
          {
            system: PARTICIPANT_TYPE_SYSTEM,
            code: 'ATND',
            display: 'attender',
          },
        ],
      },
    ],
    individual: {
      reference: `Practitioner/${practitionerId}`,
      ...(display ? { display } : {}),
    },
  };
}

export function locationEntry(
  locationId: string,
  display: string | undefined,
  status: EncounterLocation['status'],
  start?: string,
  end?: string,
): EncounterLocation {
  return {
    location: {
      reference: `Location/${locationId}`,
      ...(display ? { display } : {}),
    },
    status,
    ...(start || end
      ? { period: { ...(start ? { start } : {}), ...(end ? { end } : {}) } }
      : {}),
  };
}

export function toAdmitEncounter(
  dto: AdmitRequestDto,
  visitNumber: string,
  bedDisplay: string,
  organization?: Reference<Organization>,
  existing?: Encounter,
): Encounter {
  const start = dto.admitDateTime ?? new Date().toISOString();
  const diagnosis =
    dto.primaryDiagnosisCode || dto.primaryDiagnosisDisplay
      ? [
          {
            condition: {
              display:
                dto.primaryDiagnosisDisplay ??
                dto.primaryDiagnosisCode ??
                'Primary diagnosis',
            },
            use: {
              coding: [
                {
                  system:
                    'http://terminology.hl7.org/CodeSystem/diagnosis-role',
                  code: 'AD',
                  display: 'Admission diagnosis',
                },
              ],
            },
            rank: 1,
          },
        ]
      : undefined;

  return {
    ...existing,
    resourceType: 'Encounter',
    meta: {
      ...existing?.meta,
      tag: [
        ...(existing?.meta?.tag ?? []).filter(
          (tag) => tag.system !== ADT_EVENT_SYSTEM,
        ),
        adtEventTag('A01'),
      ],
    },
    identifier: [visitIdentifier(visitNumber)],
    status: 'in-progress',
    class: encounterClass('IMP'),
    type: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/v2-0007',
            code: dto.admitType,
            display: ADMIT_TYPE_DISPLAY[dto.admitType] ?? dto.admitType,
          },
        ],
        text: ADMIT_TYPE_DISPLAY[dto.admitType] ?? dto.admitType,
      },
    ],
    subject: { reference: `Patient/${dto.patientId}` },
    participant: dto.attendingPractitionerId
      ? [attendingParticipant(dto.attendingPractitionerId)]
      : existing?.participant,
    period: { start },
    reasonCode: dto.primaryDiagnosisDisplay
      ? [
          {
            coding: dto.primaryDiagnosisCode
              ? [
                  {
                    system: ICD10_SYSTEM,
                    code: dto.primaryDiagnosisCode,
                    display: dto.primaryDiagnosisDisplay,
                  },
                ]
              : undefined,
            text: dto.primaryDiagnosisDisplay,
          },
        ]
      : undefined,
    diagnosis,
    hospitalization: {
      admitSource: dto.admitSource
        ? {
            coding: [
              {
                system: ADMIT_SOURCE_SYSTEM,
                code: dto.admitSource,
              },
            ],
          }
        : undefined,
    },
    location: [locationEntry(dto.bedLocationId, bedDisplay, 'active', start)],
    serviceType: dto.hospitalService
      ? { text: dto.hospitalService }
      : undefined,
    ...(organization ? { serviceProvider: organization } : {}),
  };
}

export function toRegisterEncounter(
  dto: RegisterVisitRequestDto,
  visitNumber: string,
  locationDisplay: string | undefined,
  organization?: Reference<Organization>,
): Encounter {
  const start = dto.registrationDateTime ?? new Date().toISOString();
  return {
    resourceType: 'Encounter',
    meta: { tag: [adtEventTag('A04')] },
    identifier: [visitIdentifier(visitNumber)],
    status: dto.patientClass === 'EMER' ? 'arrived' : 'in-progress',
    class: encounterClass(dto.patientClass),
    subject: { reference: `Patient/${dto.patientId}` },
    participant: dto.attendingPractitionerId
      ? [attendingParticipant(dto.attendingPractitionerId)]
      : undefined,
    period: { start },
    reasonCode: dto.visitReason ? [{ text: dto.visitReason }] : undefined,
    location: dto.locationId
      ? [locationEntry(dto.locationId, locationDisplay, 'active', start)]
      : undefined,
    type: [
      ...(dto.triageCategory
        ? [
            {
              coding: [
                {
                  system: 'https://sunbird.health/fhir/triage-category',
                  code: dto.triageCategory,
                },
              ],
              text: dto.triageCategory,
            },
          ]
        : []),
      ...(dto.arrivalMode
        ? [
            {
              coding: [
                {
                  system: 'https://sunbird.health/fhir/arrival-mode',
                  code: dto.arrivalMode,
                },
              ],
              text: dto.arrivalMode,
            },
          ]
        : []),
    ],
    ...(organization ? { serviceProvider: organization } : {}),
  };
}

export function applyTransfer(
  encounter: Encounter,
  dto: TransferRequestDto,
  bedDisplay: string,
): Encounter {
  const at = dto.transferDateTime ?? new Date().toISOString();
  const prior = (encounter.location ?? []).map((entry) =>
    entry.status === 'active'
      ? {
          ...entry,
          status: 'completed' as const,
          period: { ...entry.period, end: at },
        }
      : entry,
  );

  return {
    ...encounter,
    meta: {
      ...encounter.meta,
      tag: [
        ...(encounter.meta?.tag ?? []).filter(
          (tag) => tag.system !== ADT_EVENT_SYSTEM,
        ),
        adtEventTag('A02'),
      ],
    },
    reasonCode: [...(encounter.reasonCode ?? []), { text: dto.transferReason }],
    participant: dto.attendingPractitionerId
      ? [attendingParticipant(dto.attendingPractitionerId)]
      : encounter.participant,
    location: [
      ...prior,
      locationEntry(dto.bedLocationId, bedDisplay, 'active', at),
    ],
  };
}

export function applyDischarge(
  encounter: Encounter,
  dto: DischargeRequestDto,
): Encounter {
  const locations = (encounter.location ?? []).map((entry) =>
    entry.status === 'active'
      ? {
          ...entry,
          status: 'completed' as const,
          period: { ...entry.period, end: dto.dischargeDateTime },
        }
      : entry,
  );

  return {
    ...encounter,
    meta: {
      ...encounter.meta,
      tag: [
        ...(encounter.meta?.tag ?? []).filter(
          (tag) => tag.system !== ADT_EVENT_SYSTEM,
        ),
        adtEventTag('A03'),
      ],
    },
    status: 'finished',
    period: {
      ...encounter.period,
      end: dto.dischargeDateTime,
    },
    participant: dto.attendingPractitionerId
      ? [attendingParticipant(dto.attendingPractitionerId)]
      : encounter.participant,
    hospitalization: {
      ...encounter.hospitalization,
      dischargeDisposition: {
        coding: [
          {
            system: DISCHARGE_DISPOSITION_SYSTEM,
            code: dto.dischargeDisposition,
          },
        ],
        text: dto.dischargeCondition,
      },
    },
    reasonCode: dto.dischargeDiagnosisDisplay
      ? [
          ...(encounter.reasonCode ?? []),
          {
            coding: dto.dischargeDiagnosisCode
              ? [
                  {
                    system: ICD10_SYSTEM,
                    code: dto.dischargeDiagnosisCode,
                    display: dto.dischargeDiagnosisDisplay,
                  },
                ]
              : undefined,
            text: dto.dischargeDiagnosisDisplay,
          },
        ]
      : encounter.reasonCode,
    location: locations,
  };
}

export function toPreadmitEncounter(
  dto: PreadmitRequestDto,
  visitNumber: string,
  wardDisplay: string | undefined,
  organization?: Reference<Organization>,
): Encounter {
  const status =
    dto.status === 'cancelled'
      ? 'cancelled'
      : dto.status === 'confirmed'
        ? 'planned'
        : 'planned';

  return {
    resourceType: 'Encounter',
    meta: { tag: [adtEventTag('A05')] },
    identifier: [visitIdentifier(visitNumber)],
    status,
    class: encounterClass('IMP'),
    subject: { reference: `Patient/${dto.patientId}` },
    participant: dto.attendingPractitionerId
      ? [attendingParticipant(dto.attendingPractitionerId)]
      : undefined,
    period: { start: dto.plannedStartDate },
    reasonCode: dto.plannedProcedure
      ? [{ text: dto.plannedProcedure }]
      : undefined,
    location: dto.wardLocationId
      ? [
          locationEntry(
            dto.wardLocationId,
            wardDisplay,
            'planned',
            dto.plannedStartDate,
          ),
        ]
      : undefined,
    ...(organization ? { serviceProvider: organization } : {}),
  };
}

export function toEncounterResponse(
  encounter: Encounter,
): EncounterResponseDto {
  const activeLocation =
    encounter.location?.find((entry) => entry.status === 'active') ??
    encounter.location?.find((entry) => entry.status === 'planned') ??
    encounter.location?.[encounter.location.length - 1];
  const attending = encounter.participant?.find((entry) =>
    entry.type?.some((type) =>
      type.coding?.some((coding) => coding.code === 'ATND'),
    ),
  );
  const visitNumber =
    encounter.identifier?.find((id) => id.system === VISIT_NUMBER_SYSTEM)
      ?.value ?? null;
  const lastAdtEvent =
    encounter.meta?.tag?.find((tag) => tag.system === ADT_EVENT_SYSTEM)?.code ??
    null;

  let lengthOfStayDays: number | null = null;
  if (encounter.period?.start) {
    const start = Date.parse(encounter.period.start);
    const end = encounter.period.end
      ? Date.parse(encounter.period.end)
      : Date.now();
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      lengthOfStayDays = Math.max(
        1,
        Math.ceil((end - start) / (24 * 60 * 60 * 1000)),
      );
    }
  }

  return {
    id: encounter.id ?? '',
    visitNumber,
    status: encounter.status ?? 'unknown',
    patientClass: encounter.class?.code ?? 'UNK',
    patientId: encounter.subject?.reference?.replace(/^Patient\//, '') ?? null,
    patientDisplay: encounter.subject?.display ?? null,
    locationId:
      activeLocation?.location?.reference?.replace(/^Location\//, '') ?? null,
    locationDisplay: activeLocation?.location?.display ?? null,
    attendingDisplay: attending?.individual?.display ?? null,
    periodStart: encounter.period?.start ?? null,
    periodEnd: encounter.period?.end ?? null,
    lengthOfStayDays,
    lastAdtEvent,
    lastUpdated: encounter.meta?.lastUpdated ?? null,
  };
}

export function toLocationNode(
  location: Location,
  occupiedByEncounterId?: string | null,
): LocationNodeDto {
  const physicalType =
    location.physicalType?.coding?.[0]?.code ??
    location.physicalType?.text ??
    'unk';
  return {
    id: location.id ?? '',
    name: location.name ?? location.id ?? '',
    code:
      location.identifier?.find((id) => id.system === LOCATION_CODE_SYSTEM)
        ?.value ?? null,
    physicalType,
    status: location.status ?? null,
    operationalStatus: location.operationalStatus?.code ?? null,
    partOfId: location.partOf?.reference?.replace(/^Location\//, '') ?? null,
    occupiedByEncounterId: occupiedByEncounterId ?? null,
  };
}

export function bedOperationalStatus(
  occupied: boolean,
): NonNullable<Location['operationalStatus']> {
  return occupied
    ? {
        system: LOCATION_STATUS_SYSTEM,
        code: 'O',
        display: 'Occupied',
      }
    : {
        system: LOCATION_STATUS_SYSTEM,
        code: 'U',
        display: 'Unoccupied',
      };
}

export function physicalTypeCoding(
  code: 'si' | 'wa' | 'ro' | 'bd' | 'wi',
  display: string,
) {
  return {
    coding: [
      {
        system: LOCATION_PHYSICAL_TYPE_SYSTEM,
        code,
        display,
      },
    ],
    text: display,
  };
}
