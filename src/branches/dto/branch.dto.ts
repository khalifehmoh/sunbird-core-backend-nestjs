import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { BranchStatus } from '../branch-status.enum';
import { BranchType } from '../branch-type.enum';

export class BranchRequestDto {
  @ApiProperty()
  @IsUUID()
  tenantId!: string;

  @ApiProperty({ maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[A-Z0-9][A-Z0-9_-]*$/, {
    message: 'Branch code must contain uppercase letters and numbers only',
  })
  branchCode!: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @IsNotEmpty({ message: 'Branch name is required' })
  @MaxLength(255)
  branchName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  branchNameAr?: string;

  @ApiProperty({ enum: BranchType })
  @IsEnum(BranchType)
  branchType!: BranchType;

  @IsOptional()
  @IsBoolean()
  isHeadquarters?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsEnum(BranchStatus)
  status?: BranchStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  licenseNumber?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;
}

export class UpdateBranchStatusDto {
  @ApiProperty({ enum: BranchStatus })
  @IsEnum(BranchStatus)
  status!: BranchStatus;
}

export class BranchResponseDto {
  branchId!: string;
  branchCode!: string;
  branchName!: string;
  branchNameAr!: string | null;
  branchType!: string | null;
  isHeadquarters!: boolean;
  licenseNumber!: string | null;
  contactEmail!: string | null;
  contactPhone!: string | null;
  address!: string | null;
  city!: string | null;
  region!: string | null;
  status!: BranchStatus;
  tenantId!: string;
  tenantName!: string | null;
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
