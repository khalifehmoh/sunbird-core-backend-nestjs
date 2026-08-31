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
import { PermissionOperation } from '../permission-operation.enum';

export class PermissionRequestDto {
  @ApiProperty({ maxLength: 50 })
  @IsString()
  @IsNotEmpty({ message: 'Permission code is required' })
  @MaxLength(50)
  @Matches(/^[A-Z0-9][A-Z0-9_:.-]*$/, {
    message:
      'Permission code must contain uppercase letters, numbers, colons, dots, hyphens, or underscores',
  })
  permissionCode!: string;

  @ApiProperty()
  @IsUUID()
  moduleId!: string;

  @ApiProperty({ enum: PermissionOperation })
  @IsEnum(PermissionOperation, {
    message:
      'Operation must be CREATE, READ, UPDATE, DELETE, EXPORT, APPROVE, or PRINT',
  })
  operation!: PermissionOperation;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @IsNotEmpty({ message: 'Display name is required' })
  @MaxLength(255)
  permissionName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  permissionNameAr?: string;
}

export class PermissionResponseDto {
  permissionId!: string;
  permissionCode!: string;
  permissionName!: string;
  permissionNameAr!: string | null;
  operation!: string;
  moduleId!: string;
  moduleCode!: string;
  moduleName!: string;
  moduleNameAr!: string | null;
  roleCount!: number;
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
