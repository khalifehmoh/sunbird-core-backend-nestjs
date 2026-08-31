import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { TenantStatus } from '../../tenants/tenant-status.enum';

export class RoleRequestDto {
  @ApiProperty({ maxLength: 50 })
  @IsString()
  @IsNotEmpty({ message: 'Role code is required' })
  @MaxLength(50)
  @Matches(/^[A-Z0-9][A-Z0-9_-]*$/, {
    message: 'Role code must contain uppercase letters and numbers only',
  })
  roleCode!: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @IsNotEmpty({ message: 'Role name is required' })
  @MaxLength(255)
  roleName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  roleNameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  roleDescription?: string;

  @ApiPropertyOptional({
    description: 'Omit or null for a global role; required for tenant-specific',
  })
  @ValidateIf((_, value) => value != null && value !== '')
  @IsUUID()
  tenantId?: string | null;

  @ApiPropertyOptional({ enum: TenantStatus })
  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;
}

export class RoleResponseDto {
  roleId!: string;
  roleCode!: string;
  roleName!: string;
  roleNameAr!: string | null;
  roleDescription!: string | null;
  isSystemRole!: boolean;
  status!: TenantStatus;
  tenantId!: string | null;
  tenantName!: string | null;
  permissionCount!: number;
  userCount!: number;
  groupCount!: number;
  createdAt!: string | null;
  updatedAt!: string | null;
}

export class RoleOptionDto {
  roleId!: string;
  roleCode!: string;
  roleName!: string;
  roleNameAr!: string | null;
  isSystemRole!: boolean;
}

export class RolePermissionItemDto {
  permissionId!: string;
  permissionCode!: string;
  permissionName!: string;
  moduleId!: string;
  moduleCode!: string;
  operation!: string;
  grantedAt!: string | null;
}

export class BatchRolePermissionsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  permissionIds!: string[];

  @ApiPropertyOptional({
    description: 'When true, revoke the listed permissions instead of granting',
  })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  revoke?: boolean;
}

export class PagedResponseDto<T> {
  content!: T[];
  page!: number;
  size!: number;
  totalElements!: number;
  totalPages!: number;
  last!: boolean;
}
