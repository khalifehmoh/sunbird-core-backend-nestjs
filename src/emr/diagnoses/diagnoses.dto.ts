import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { PatientScopedQueryDto } from '../common/dto';

export const DIAGNOSIS_TYPES = [
  'PRIMARY',
  'SECONDARY',
  'ADMITTING',
  'WORKING',
  'DISCHARGE',
] as const;
export type DiagnosisType = (typeof DIAGNOSIS_TYPES)[number];

export class CreateDiagnosisDto {
  @IsUUID()
  patientId!: string;

  @IsUUID()
  encounterId!: string;

  @IsIn(DIAGNOSIS_TYPES)
  type!: DiagnosisType;

  /** ICD-10 code, e.g. `J18.9`. */
  @IsString()
  @Matches(/^[A-TV-Z][0-9][0-9AB](\.[0-9A-TV-Z]{1,4})?$/i, {
    message: 'code must be a valid ICD-10 code such as J18.9',
  })
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  display!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class DiagnosesQueryDto extends PatientScopedQueryDto {
  @IsOptional()
  @IsIn(DIAGNOSIS_TYPES)
  type?: DiagnosisType;
}

export type DiagnosisRow = {
  id: string;
  patientId: string | null;
  encounterId: string | null;
  type: DiagnosisType | null;
  code: string | null;
  display: string | null;
  verification: string | null;
  notes: string | null;
  recordedAt: string | null;
};
