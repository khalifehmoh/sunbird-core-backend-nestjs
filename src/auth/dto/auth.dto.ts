import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
export class LoginRequestDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Username is required' })
  username!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  password!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  rememberMe: boolean = false;
}

export class RegisterRequestDto {
  @ApiProperty({ minLength: 3, maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: 'Username is required' })
  @MinLength(3, { message: 'Username must be between 3 and 100 characters' })
  @MaxLength(100, { message: 'Username must be between 3 and 100 characters' })
  username!: string;

  @ApiProperty()
  @IsNotEmpty({ message: 'Email is required' })
  @IsEmail({}, { message: 'Email must be valid' })
  email!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fullNameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  firstNameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  lastNameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tenantCode?: string;
}

export class ChangePasswordRequestDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Current password is required' })
  @MinLength(8, { message: 'Current password must be at least 8 characters' })
  currentPassword!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'New password is required' })
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  newPassword!: string;
}

export class AuthResponseDto {
  accessTokenExpiresIn!: number;
  refreshTokenExpiresIn!: number;
  username!: string;
  email!: string;
  role!: string | null;
  tenantId!: string | null;
  requirePasswordChange!: boolean;
  mfaEnabled!: boolean;
  permissions!: string[];
}

export class SessionResponseDto {
  username!: string;
  email!: string;
  role!: string | null;
  tenantId!: string | null;
  requirePasswordChange!: boolean;
  mfaEnabled!: boolean;
  permissions!: string[];
}

export class ChangePasswordResponseDto {
  message!: string;
  requirePasswordChange!: boolean;
}
