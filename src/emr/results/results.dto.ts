import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { PatientScopedQueryDto } from '../common/dto';
import type { EntrySource } from '../emr.constants';

export const REPORT_STATUSES = [
  'registered',
  'partial',
  'preliminary',
  'final',
  'corrected',
  'amended',
  'cancelled',
] as const;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' || value === true
    ? true
    : value === 'false' || value === false
      ? false
      : value;

export class ResultsQueryDto extends PatientScopedQueryDto {
  @IsOptional()
  @IsIn(REPORT_STATUSES)
  status?: (typeof REPORT_STATUSES)[number];

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  criticalOnly?: boolean;
}

export class CriticalQueryDto extends PatientScopedQueryDto {}

/** One OBX line of an inbound result. */
export type InboundObservation = {
  code: string;
  display: string;
  /** Numeric results become a quantity; anything else is kept as text. */
  value: string;
  unit?: string;
  referenceRange?: string;
  /** HL7 abnormal flag (OBX-8): N, L, H, LL, HH, A, AA. */
  flag?: string;
  /** HL7 result status (OBX-11): F final, C corrected, P preliminary. */
  status?: string;
  observedAt?: string;
};

/** A result ready to store, after the integration layer has parsed it. */
export type InboundResult = {
  patientId: string;
  /** Placer order number (OBR-2); links the result to its ServiceRequest. */
  orderNumber?: string;
  /** Message control id (MSH-10); makes redelivery idempotent. */
  controlId: string;
  code: string;
  display: string;
  type: 'LAB' | 'RAD';
  issuedAt?: string;
  conclusion?: string;
  observations: InboundObservation[];
  source: EntrySource;
};

export type ObservationRow = {
  id: string;
  code: string | null;
  display: string | null;
  value: string | null;
  numericValue: number | null;
  unit: string | null;
  referenceRange: string | null;
  interpretation: string | null;
  flag: 'critical' | 'abnormal' | 'normal' | 'unrated';
  status: string;
  corrected: boolean;
  observedAt: string | null;
};

export type ResultRow = {
  id: string;
  controlId: string | null;
  orderNumber: string | null;
  type: string | null;
  code: string | null;
  display: string | null;
  status: string;
  hasCritical: boolean;
  patientId: string | null;
  patientName: string | null;
  mrn: string | null;
  encounterId: string | null;
  issuedAt: string | null;
  conclusion: string | null;
  source: string;
};

export type ResultDetail = ResultRow & { observations: ObservationRow[] };

export type CriticalAlert = ObservationRow & {
  patientId: string | null;
  patientName: string | null;
  mrn: string | null;
  reportId: string | null;
};
