import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** FHIR Encounter.class codes used by ADT. */
export const PATIENT_CLASSES = ['IMP', 'AMB', 'EMER'] as const;
export type PatientClass = (typeof PATIENT_CLASSES)[number];

export const ADMIT_TYPES = [
  'routine',
  'urgent',
  'elective',
  'emergency',
] as const;
export const ADMIT_SOURCES = [
  'phys-ref',
  'emd',
  'outp',
  'born',
  'gp',
  'mp',
  'nursing',
  'psych',
  'rehabilitation',
  'other',
] as const;
export const DISCHARGE_DISPOSITIONS = [
  'home',
  'alt-home',
  'other-hcf',
  'hosp',
  'long',
  'aadvice',
  'exp',
  'psy',
  'rehab',
  'snf',
  'oth',
] as const;
export const DISCHARGE_CONDITIONS = [
  'improved',
  'stable',
  'worsened',
  'expired',
] as const;
export const PREADMIT_STATUSES = ['pending', 'confirmed', 'cancelled'] as const;
export const TRIAGE_CATEGORIES = [
  'immediate',
  'very-urgent',
  'urgent',
  'standard',
  'non-urgent',
] as const;
export const ARRIVAL_MODES = [
  'walk-in',
  'ambulance',
  'referral',
  'other',
] as const;

export class AdmitRequestDto {
  @ApiProperty()
  @IsUUID()
  patientId!: string;

  @ApiPropertyOptional({ description: 'Auto-assigned when omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  visitNumber?: string;

  @ApiProperty({ enum: ADMIT_TYPES })
  @IsIn(ADMIT_TYPES)
  admitType!: (typeof ADMIT_TYPES)[number];

  @ApiPropertyOptional({ enum: ADMIT_SOURCES })
  @IsOptional()
  @IsIn(ADMIT_SOURCES)
  admitSource?: (typeof ADMIT_SOURCES)[number];

  @ApiProperty({ description: 'Bed Location id' })
  @IsUUID()
  bedLocationId!: string;

  @ApiPropertyOptional({ description: 'Attending Practitioner id' })
  @IsOptional()
  @IsUUID()
  attendingPractitionerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  primaryDiagnosisCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  primaryDiagnosisDisplay?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  hospitalService?: string;

  @ApiPropertyOptional({ description: 'ISO-8601; defaults to now' })
  @IsOptional()
  @IsISO8601()
  admitDateTime?: string;
}

export class RegisterVisitRequestDto {
  @ApiProperty()
  @IsUUID()
  patientId!: string;

  @ApiProperty({ enum: PATIENT_CLASSES, description: 'AMB = OPD, EMER = ED' })
  @IsIn(['AMB', 'EMER'] as const)
  patientClass!: Exclude<PatientClass, 'IMP'>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  visitNumber?: string;

  @ApiPropertyOptional({ description: 'Clinic / ED Location id' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  attendingPractitionerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  registrationDateTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  visitReason?: string;

  @ApiPropertyOptional({ enum: TRIAGE_CATEGORIES })
  @IsOptional()
  @IsIn(TRIAGE_CATEGORIES)
  triageCategory?: (typeof TRIAGE_CATEGORIES)[number];

  @ApiPropertyOptional({ enum: ARRIVAL_MODES })
  @IsOptional()
  @IsIn(ARRIVAL_MODES)
  arrivalMode?: (typeof ARRIVAL_MODES)[number];
}

export class TransferRequestDto {
  @ApiProperty({ description: 'Active inpatient Encounter id' })
  @IsUUID()
  encounterId!: string;

  @ApiProperty({ description: 'Destination bed Location id' })
  @IsUUID()
  bedLocationId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  transferReason!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  attendingPractitionerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  transferDateTime?: string;
}

export class DischargeRequestDto {
  @ApiProperty()
  @IsUUID()
  encounterId!: string;

  @ApiProperty()
  @IsISO8601()
  dischargeDateTime!: string;

  @ApiProperty({ enum: DISCHARGE_DISPOSITIONS })
  @IsIn(DISCHARGE_DISPOSITIONS)
  dischargeDisposition!: (typeof DISCHARGE_DISPOSITIONS)[number];

  @ApiProperty({ enum: DISCHARGE_CONDITIONS })
  @IsIn(DISCHARGE_CONDITIONS)
  dischargeCondition!: (typeof DISCHARGE_CONDITIONS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  attendingPractitionerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  dischargeDiagnosisCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  dischargeDiagnosisDisplay?: string;
}

export class PreadmitRequestDto {
  @ApiProperty()
  @IsUUID()
  patientId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  visitNumber?: string;

  @ApiProperty({ description: 'Planned admit date (YYYY-MM-DD or ISO-8601)' })
  @IsString()
  @IsNotEmpty()
  plannedStartDate!: string;

  @ApiPropertyOptional({ description: 'Planned ward Location id' })
  @IsOptional()
  @IsUUID()
  wardLocationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  plannedProcedure?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  attendingPractitionerId?: string;

  @ApiPropertyOptional({ enum: PREADMIT_STATUSES, default: 'pending' })
  @IsOptional()
  @IsIn(PREADMIT_STATUSES)
  status?: (typeof PREADMIT_STATUSES)[number];
}

export class EncounterResponseDto {
  @ApiProperty()
  id!: string;

  @ApiPropertyOptional({ nullable: true })
  visitNumber!: string | null;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  patientClass!: string;

  @ApiPropertyOptional({ nullable: true })
  patientId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  patientDisplay!: string | null;

  @ApiPropertyOptional({ nullable: true })
  locationId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  locationDisplay!: string | null;

  @ApiPropertyOptional({ nullable: true })
  attendingDisplay!: string | null;

  @ApiPropertyOptional({ nullable: true })
  periodStart!: string | null;

  @ApiPropertyOptional({ nullable: true })
  periodEnd!: string | null;

  @ApiPropertyOptional({ nullable: true })
  lengthOfStayDays!: number | null;

  @ApiPropertyOptional({ nullable: true })
  lastAdtEvent!: string | null;

  @ApiPropertyOptional({ nullable: true })
  lastUpdated!: string | null;
}

export class LocationNodeDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  code!: string | null;

  @ApiProperty()
  physicalType!: string;

  @ApiPropertyOptional({ nullable: true })
  status!: string | null;

  @ApiPropertyOptional({ nullable: true })
  operationalStatus!: string | null;

  @ApiPropertyOptional({ nullable: true })
  partOfId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  occupiedByEncounterId!: string | null;
}

export class BedBoardResponseDto {
  @ApiProperty({ type: [LocationNodeDto] })
  locations!: LocationNodeDto[];
}
