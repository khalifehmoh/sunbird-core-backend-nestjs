import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TenantStatus } from '../../tenants/tenant-status.enum';
import { User } from './user.entity';

@Entity({ name: 'tenants', schema: 'core' })
export class Tenant {
  @PrimaryGeneratedColumn('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column({ name: 'tenant_code', type: 'varchar', length: 50, unique: true })
  tenantCode!: string;

  @Column({ name: 'tenant_name', type: 'varchar', length: 255 })
  tenantName!: string;

  @Column({
    name: 'tenant_name_ar',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  tenantNameAr!: string | null;

  @Column({
    name: 'organization_type',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  organizationType!: string | null;

  @Column({
    name: 'license_number',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  licenseNumber!: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: TenantStatus,
    enumName: 'tenant_status',
    default: TenantStatus.ACTIVE,
  })
  status!: TenantStatus;

  @Column({ name: 'max_users', type: 'integer', nullable: true, default: 50 })
  maxUsers!: number | null;

  @Column({
    name: 'max_branches',
    type: 'integer',
    nullable: true,
    default: 10,
  })
  maxBranches!: number | null;

  @Column({ name: 'is_deleted', type: 'boolean', default: false })
  isDeleted!: boolean;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp without time zone',
    update: false,
    nullable: true,
  })
  createdAt!: Date | null;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamp without time zone',
    nullable: true,
  })
  updatedAt!: Date | null;

  @OneToMany(() => User, (user) => user.tenant)
  users!: User[];
}
