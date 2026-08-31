import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserStatus } from '../../auth/user-status.enum';
import { Tenant } from './tenant.entity';

@Entity({ name: 'users', schema: 'core' })
export class User {
  @PrimaryGeneratedColumn('uuid', { name: 'user_id' })
  userId!: string;

  @ManyToOne(() => Tenant, (tenant) => tenant.users, { nullable: true })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant | null;

  @Column({ name: 'default_branch_id', type: 'uuid', nullable: true })
  defaultBranchId!: string | null;

  @Column({ name: 'username', type: 'varchar', length: 100 })
  username!: string;

  @Column({ name: 'email', type: 'varchar', length: 255 })
  email!: string;

  @Column({ name: 'email_verified', type: 'boolean', default: false })
  emailVerified!: boolean;

  @Column({
    name: 'mobile_number',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  mobileNumber!: string | null;

  @Column({ name: 'first_name', type: 'varchar', length: 100 })
  firstName!: string;

  @Column({ name: 'last_name', type: 'varchar', length: 100 })
  lastName!: string;

  @Column({
    name: 'first_name_ar',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  firstNameAr!: string | null;

  @Column({
    name: 'last_name_ar',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  lastNameAr!: string | null;

  @Column({
    name: 'employee_id',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  employeeId!: string | null;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash!: string;

  @Column({ name: 'require_password_change', type: 'boolean', default: true })
  requirePasswordChange!: boolean;

  @Column({
    name: 'password_last_changed_at',
    type: 'timestamp without time zone',
    nullable: true,
  })
  passwordLastChangedAt!: Date | null;

  @Column({ name: 'failed_login_attempts', type: 'integer', default: 0 })
  failedLoginAttempts!: number;

  @Column({
    name: 'account_locked_until',
    type: 'timestamp without time zone',
    nullable: true,
  })
  accountLockedUntil!: Date | null;

  @Column({
    name: 'last_login_at',
    type: 'timestamp without time zone',
    nullable: true,
  })
  lastLoginAt!: Date | null;

  @Column({
    name: 'last_login_ip',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  lastLoginIp!: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: UserStatus,
    enumName: 'user_status',
    default: UserStatus.ACTIVE,
  })
  status!: UserStatus;

  @Column({ name: 'mfa_enabled', type: 'boolean', default: false })
  mfaEnabled!: boolean;

  @Column({ name: 'is_deleted', type: 'boolean', default: false })
  isDeleted!: boolean;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp without time zone',
    update: false,
  })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp without time zone' })
  updatedAt!: Date;

  /** Populated from JWT / user_roles; not a users-table column. */
  role?: string | null;
}