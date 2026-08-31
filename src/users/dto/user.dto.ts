import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../auth/user-role.enum';
import { UserStatus } from '../../auth/user-status.enum';

export class UserRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: 'Username is required' })
  @MinLength(3)
  @MaxLength(100)
  @Matches(/^[a-z0-9._]+$/, {
    message:
      'Username must be lowercase alphanumeric with underscores or dots',
  })
  username!: string;

  @ApiProperty()
  @IsEmail()
  @IsNotEmpty({ message: 'Email is required' })
  @MaxLength(255)
  email!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'First name is required' })
  @MaxLength(100)
  firstName!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Last name is required' })
  @MaxLength(100)
  lastName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstNameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastNameAr?: string;

  @ApiPropertyOptional({ enum: UserRole })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  mfaEnabled?: boolean;
}

export class UpdateUserStatusDto {
  @ApiProperty({ enum: UserStatus })
  @IsEnum(UserStatus)
  status!: UserStatus;
}

export class BulkUpdateUserStatusDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  userIds!: string[];

  @ApiProperty({ enum: UserStatus })
  @IsEnum(UserStatus)
  status!: UserStatus;
}

export class UserResponseDto {
  userId!: string;
  username!: string;
  email!: string;
  firstName!: string | null;
  lastName!: string | null;
  firstNameAr!: string | null;
  lastNameAr!: string | null;
  fullName!: string | null;
  fullNameAr!: string | null;
  role!: UserRole;
  status!: UserStatus;
  mfaEnabled!: boolean;
  requirePasswordChange!: boolean;
  lastLoginAt!: string | null;
  lastLoginIp!: string | null;
  tenantId!: string | null;
  tenantName!: string | null;
  createdAt!: string | null;
  updatedAt!: string | null;
  temporaryPassword?: string;
}

export class UserRoleResponseDto {
  userRoleId!: string | null;
  roleId!: string;
  roleCode!: string;
  roleName!: string;
  roleNameAr!: string | null;
  isSystemRole!: boolean;
  assignedAt!: string | null;
  source!: 'DIRECT' | 'GROUP';
  groupId!: string | null;
  groupName!: string | null;
}

export class UserGroupResponseDto {
  memberId!: string;
  groupId!: string;
  groupCode!: string;
  groupName!: string;
  groupNameAr!: string | null;
  status!: string;
  joinedAt!: string | null;
}

export class EffectivePermissionDto {
  permissionId!: string;
  permissionCode!: string;
  permissionName!: string;
  moduleId!: string;
  moduleCode!: string;
  operation!: string;
  sources!: Array<'DIRECT' | 'GROUP'>;
}

export class UserSessionResponseDto {
  sessionId!: string;
  loginAt!: string | null;
  lastActivityAt!: string | null;
  ipAddress!: string | null;
  userAgent!: string | null;
  expiresAt!: string | null;
  isActive!: boolean;
  isRevoked!: boolean;
}

export class ActiveSessionResponseDto extends UserSessionResponseDto {
  userId!: string;
  username!: string;
  fullName!: string | null;
  tenantId!: string | null;
  tenantName!: string | null;
}

export class PagedResponseDto<T> {
  content!: T[];
  page!: number;
  size!: number;
  totalElements!: number;
  totalPages!: number;
  last!: boolean;
}
