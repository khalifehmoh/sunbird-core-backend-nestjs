import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** Shared query-string pieces. */
export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class DateRangeQueryDto extends PageQueryDto {
  /** Inclusive lower bound, ISO 8601 date or date-time. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Exclusive upper bound, ISO 8601 date or date-time. */
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class PatientScopedQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @IsUUID()
  patientId?: string;

  @IsOptional()
  @IsUUID()
  encounterId?: string;
}
