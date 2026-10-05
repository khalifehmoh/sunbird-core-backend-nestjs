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

export const ORDER_TYPES = ['LAB', 'RAD'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_PRIORITIES = ['ROUTINE', 'URGENT', 'STAT'] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

export const ORDER_STATUSES = [
  'draft',
  'active',
  'on-hold',
  'completed',
  'revoked',
  'entered-in-error',
] as const;

export class CreateOrderDto {
  @IsUUID()
  patientId!: string;

  @IsOptional()
  @IsUUID()
  encounterId?: string;

  @IsIn(ORDER_TYPES)
  type!: OrderType;

  /** LOINC code, e.g. `58410-2`. */
  @Matches(/^\d{1,7}-\d$/, {
    message: 'code must be a LOINC code such as 718-7',
  })
  code!: string;

  /** Required unless the code is in the starter catalog. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  display?: string;

  @IsOptional()
  @IsIn(ORDER_PRIORITIES)
  priority?: OrderPriority;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CancelOrderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class OrdersQueryDto extends PatientScopedQueryDto {
  @IsOptional()
  @IsIn(ORDER_TYPES)
  type?: OrderType;

  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: (typeof ORDER_STATUSES)[number];

  @IsOptional()
  @IsIn(ORDER_PRIORITIES)
  priority?: OrderPriority;
}

export class CatalogQueryDto {
  @IsOptional()
  @IsIn(ORDER_TYPES)
  type?: OrderType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export type OrderRow = {
  id: string;
  orderNumber: string | null;
  type: OrderType | null;
  code: string | null;
  display: string | null;
  priority: OrderPriority;
  status: string;
  patientId: string | null;
  patientName: string | null;
  mrn: string | null;
  encounterId: string | null;
  orderedAt: string | null;
  notes: string | null;
};
