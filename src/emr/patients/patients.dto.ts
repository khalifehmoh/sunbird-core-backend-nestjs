import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../common/dto';

export const WORKLIST_FILTERS = [
  'all',
  'inpatient',
  'opd',
  'ed',
  'critical',
] as const;
export type WorklistFilter = (typeof WORKLIST_FILTERS)[number];

export class WorklistQueryDto extends PageQueryDto {
  /** Name, MRN, or mobile number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(WORKLIST_FILTERS)
  filter?: WorklistFilter;
}

/** Saudi national id (starts 1) or iqama (starts 2): ten digits. */
export const SAUDI_ID_PATTERN = /^[12]\d{9}$/;
export const PHONE_PATTERN = /^\+?[0-9]{8,15}$/;

export class EmergencyContactDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  relationship?: string;

  @Matches(PHONE_PATTERN, {
    message: 'phone must be 8-15 digits, optionally starting with +',
  })
  phone!: string;
}

export class RegisterPatientDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  lastName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  firstNameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  lastNameAr?: string;

  @IsIn(['male', 'female', 'other', 'unknown'])
  gender!: 'male' | 'female' | 'other' | 'unknown';

  /** `YYYY-MM-DD`, not in the future. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'birthDate must be YYYY-MM-DD' })
  birthDate!: string;

  @IsOptional()
  @Matches(SAUDI_ID_PATTERN, {
    message:
      'nationalId must be 10 digits starting with 1 (citizen) or 2 (resident)',
  })
  nationalId?: string;

  @IsOptional()
  @Matches(PHONE_PATTERN, {
    message: 'mobile must be 8-15 digits, optionally starting with +',
  })
  mobile?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(120)
  email?: string;

  /** Language of patient messages. Defaults to English. */
  @IsOptional()
  @IsIn(['en', 'ar'])
  preferredLanguage?: 'en' | 'ar';

  @IsOptional()
  @ValidateNested()
  @Type(() => EmergencyContactDto)
  emergencyContact?: EmergencyContactDto;
}

export type PatientClassCode = 'IMP' | 'AMB' | 'EMER';

export type WorklistItem = {
  id: string;
  mrn: string | null;
  name: string;
  nameAr: string | null;
  gender: string | null;
  birthDate: string | null;
  ageYears: number | null;
  mobile: string | null;
  /** Class of the active encounter; null when the patient has none. */
  patientClass: string | null;
  encounterId: string | null;
  visitNumber: string | null;
  ward: string | null;
  location: string | null;
  /** The active encounter's start, else the record's last update. */
  lastActivity: string | null;
  critical: boolean;
  hasAllergy: boolean;
};

export type RegisteredPatient = {
  id: string;
  mrn: string;
  name: string;
  nameAr: string | null;
  entrySource: 'MANUAL';
};
