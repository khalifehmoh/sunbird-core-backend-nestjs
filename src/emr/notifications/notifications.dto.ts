import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { DateRangeQueryDto } from '../common/dto';
import { NOTIFICATION_EVENTS } from './notification-events';

export const CHANNELS = ['SMS', 'WHATSAPP', 'EMAIL'] as const;
export const LANGUAGES = ['en', 'ar'] as const;
export const STATUSES = ['PENDING', 'SENT', 'FAILED'] as const;
const EVENT_CODES = NOTIFICATION_EVENTS.map((event) => event.code);

export class NotificationLogQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @IsOptional()
  @IsIn(CHANNELS)
  channel?: (typeof CHANNELS)[number];

  @IsOptional()
  @IsIn(EVENT_CODES)
  eventCode?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  patientId?: string;
}

export class CreateTemplateDto {
  @IsIn(EVENT_CODES)
  eventCode!: string;

  @IsIn(LANGUAGES)
  language!: (typeof LANGUAGES)[number];

  @IsIn(CHANNELS)
  channel!: (typeof CHANNELS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  subject?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  body!: string;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  subject?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  body?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PreviewTemplateDto {
  @IsIn(EVENT_CODES)
  eventCode!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  body!: string;

  /** Sample values; anything left out renders as a visible gap. */
  @IsOptional()
  @IsObject()
  values?: Record<string, string>;
}

export class TemplateIdParam {
  @IsUUID()
  id!: string;
}

export type TemplateRow = {
  id: string;
  eventCode: string;
  eventLabel: string;
  language: string;
  channel: string;
  subject: string | null;
  body: string;
  isActive: boolean;
  placeholders: string[];
  updatedAt: string;
};

export type NotificationLogRow = {
  id: string;
  eventCode: string;
  channel: string;
  language: string;
  recipient: string | null;
  patientId: string | null;
  body: string;
  status: string;
  provider: string | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
};
