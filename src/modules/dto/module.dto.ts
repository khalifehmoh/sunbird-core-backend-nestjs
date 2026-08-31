import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { TenantStatus } from '../../tenants/tenant-status.enum';

export class ModuleRequestDto {
  @ApiProperty({ maxLength: 50 })
  @IsString()
  @IsNotEmpty({ message: 'Module code is required' })
  @MaxLength(50)
  @Matches(/^[A-Z0-9][A-Z0-9_-]*$/, {
    message: 'Module code must contain uppercase letters and numbers only',
  })
  moduleCode!: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @IsNotEmpty({ message: 'Module name is required' })
  @MaxLength(255)
  moduleName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  moduleNameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  moduleDescription?: string;

  @ApiPropertyOptional({ enum: TenantStatus })
  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;
}

export class ModulePermissionItemDto {
  permissionId!: string;
  permissionCode!: string;
  permissionName!: string;
  permissionNameAr!: string | null;
  operation!: string;
}

export class ModuleCatalogDto {
  moduleId!: string;
  moduleCode!: string;
  moduleName!: string;
  moduleNameAr!: string | null;
  moduleDescription!: string | null;
  isSystemModule!: boolean;
  displayOrder!: number | null;
  status!: TenantStatus;
  permissions!: ModulePermissionItemDto[];
}

export class ModuleResponseDto {
  moduleId!: string;
  moduleCode!: string;
  moduleName!: string;
  moduleNameAr!: string | null;
  moduleDescription!: string | null;
  isSystemModule!: boolean;
  displayOrder!: number | null;
  status!: TenantStatus;
  permissionCount!: number;
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
