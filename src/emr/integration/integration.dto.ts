import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PageQueryDto } from '../common/dto';

export class MessagesQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['RECEIVED', 'PROCESSED', 'FAILED'])
  status?: 'RECEIVED' | 'PROCESSED' | 'FAILED';

  /** e.g. `ORU^R01`. */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  messageType?: string;

  /** Part of the message control id. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class SubmitMessageDto {
  @IsString()
  @MaxLength(256 * 1024)
  message!: string;
}
