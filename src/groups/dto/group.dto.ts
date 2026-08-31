import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { TenantStatus } from '../../tenants/tenant-status.enum';

export class GroupRequestDto {
  @ApiProperty()
  @IsUUID()
  tenantId!: string;

  @ApiProperty({ maxLength: 50 })
  @IsString()
  @IsNotEmpty({ message: 'Group code is required' })
  @MaxLength(50)
  @Matches(/^[A-Z0-9][A-Z0-9_-]*$/, {
    message: 'Group code must contain uppercase letters and numbers only',
  })
  groupCode!: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @IsNotEmpty({ message: 'Group name is required' })
  @MaxLength(255)
  groupName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  groupNameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  groupDescription?: string;

  @ApiPropertyOptional({ enum: TenantStatus })
  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;
}

export class GroupResponseDto {
  groupId!: string;
  groupCode!: string;
  groupName!: string;
  groupNameAr!: string | null;
  groupDescription!: string | null;
  status!: TenantStatus;
  memberCount!: number;
  roleCount!: number;
  tenantId!: string;
  tenantName!: string | null;
  createdAt!: string | null;
  updatedAt!: string | null;
}

export class GroupMemberResponseDto {
  memberId!: string;
  userId!: string;
  username!: string;
  email!: string;
  fullName!: string;
  joinedAt!: string | null;
}

export class GroupRoleResponseDto {
  groupRoleId!: string;
  roleId!: string;
  roleCode!: string;
  roleName!: string;
  roleNameAr!: string | null;
  isSystemRole!: boolean;
  assignedAt!: string | null;
  inheritedMemberCount!: number;
}

export class RoleOptionDto {
  roleId!: string;
  roleCode!: string;
  roleName!: string;
  roleNameAr!: string | null;
  isSystemRole!: boolean;
}

export class PagedResponseDto<T> {
  content!: T[];
  page!: number;
  size!: number;
  totalElements!: number;
  totalPages!: number;
  last!: boolean;
}
