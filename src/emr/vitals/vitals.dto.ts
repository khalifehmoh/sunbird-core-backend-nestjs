import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PatientScopedQueryDto } from '../common/dto';
import { VITAL_KEYS, type VitalFlag } from './vitals.rules';

export class VitalReadingDto {
  @IsIn(VITAL_KEYS)
  code!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  value!: number;
}

export class RecordVitalsDto {
  @IsUUID()
  patientId!: string;

  @IsOptional()
  @IsUUID()
  encounterId?: string;

  /** When the vitals were taken. Defaults to now; cannot be in the future. */
  @IsOptional()
  @IsISO8601()
  measuredAt?: string;

  /** MANUAL (typed in) or DEVICE (bedside monitor entry). */
  @IsOptional()
  @IsIn(['MANUAL', 'DEVICE'])
  source?: 'MANUAL' | 'DEVICE';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VITAL_KEYS.length)
  @ValidateNested({ each: true })
  @Type(() => VitalReadingDto)
  readings!: VitalReadingDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class VitalsQueryDto extends PatientScopedQueryDto {
  /** Only critical readings. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false'
        ? false
        : value,
  )
  @IsBoolean()
  criticalOnly?: boolean;
}

export type VitalRow = {
  id: string;
  patientId: string | null;
  encounterId: string | null;
  code: string;
  loinc: string;
  display: string;
  value: number;
  unit: string;
  interpretation: string | null;
  flag: VitalFlag;
  measuredAt: string | null;
  source: string;
};

export type VitalsResponse = {
  items: VitalRow[];
  summary: { total: number; critical: number; abnormal: number };
};
