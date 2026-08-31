import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { TenantStatus } from '../tenant-status.enum';

export class TenantRequestDto {
  @ApiProperty({ maxLength: 50 })
  @IsString()
  @IsNotEmpty({ message: 'Code is required' })
  @MaxLength(50)
  tenantCode!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  tenantName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tenantNameAr?: string;

  @ApiPropertyOptional({
    enum: ['HOSPITAL', 'NETWORK', 'CLINIC', 'LAB', 'PHARMACY'],
  })
  @IsOptional()
  @Matches(/^(HOSPITAL|NETWORK|CLINIC|LAB|PHARMACY)$/)
  organizationType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  licenseNumber?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxUsers: number = 50;
}

export class UpdateTenantStatusDto {
  @ApiProperty({ enum: TenantStatus })
  @IsEnum(TenantStatus)
  status!: TenantStatus;
}

export class TenantResponseDto {
  tenantId!: string;
  tenantCode!: string;
  tenantName!: string;
  tenantNameAr!: string | null;
  organizationType!: string | null;
  licenseNumber!: string | null;
  status!: TenantStatus;
  maxUsers!: number | null;
  createdAt!: string | null;
  updatedAt!: string | null;
}

export class PagedResponseDto<T> {
  content!: T[];
  page!: number;
  size!: number;
  totalElements!: number;
  totalPages!: number;
  last!: boolean;
}
