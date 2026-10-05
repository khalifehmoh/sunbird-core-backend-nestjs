import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DateRangeQueryDto } from '../common/dto';

export const APPOINTMENT_TYPES = [
  'ROUTINE',
  'CHECKUP',
  'FOLLOWUP',
  'WALKIN',
  'EMERGENCY',
] as const;
export type AppointmentTypeCode = (typeof APPOINTMENT_TYPES)[number];

export const APPOINTMENT_STATUSES = [
  'booked',
  'arrived',
  'fulfilled',
  'cancelled',
  'noshow',
] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class SlotsQueryDto {
  @IsUUID()
  practitionerId!: string;

  /** First local day of the range, `YYYY-MM-DD`. */
  @Matches(DATE, { message: 'from must be a date such as 2026-10-04' })
  from!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(14)
  days?: number;
}

export class BookAppointmentDto {
  @IsUUID()
  patientId!: string;

  @IsUUID()
  practitionerId!: string;

  @IsISO8601({ strict: true })
  start!: string;

  /** Multiple of 30 minutes. Defaults to 30. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(240)
  durationMinutes?: number;

  @IsOptional()
  @IsIn(APPOINTMENT_TYPES)
  type?: AppointmentTypeCode;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CancelAppointmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class AppointmentsQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @IsIn(APPOINTMENT_STATUSES)
  status?: (typeof APPOINTMENT_STATUSES)[number];

  @IsOptional()
  @IsUUID()
  practitionerId?: string;

  @IsOptional()
  @IsUUID()
  patientId?: string;
}

export type AppointmentRow = {
  id: string;
  status: string;
  start: string | null;
  end: string | null;
  durationMinutes: number | null;
  type: string | null;
  reason: string | null;
  patientId: string | null;
  patientName: string | null;
  mrn: string | null;
  practitionerId: string | null;
  practitionerName: string | null;
  cancellationReason: string | null;
  createdAt: string | null;
};
