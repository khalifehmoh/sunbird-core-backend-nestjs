import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TenantStatus } from '../../tenants/tenant-status.enum';
import { Tenant } from './tenant.entity';

@Entity({ name: 'roles', schema: 'core' })
export class Role {
  @PrimaryGeneratedColumn('uuid', { name: 'role_id' })
  roleId!: string;

  @ManyToOne(() => Tenant, { nullable: true })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant | null;

  @Column({ name: 'role_code', type: 'varchar', length: 50 })
  roleCode!: string;

  @Column({ name: 'role_name', type: 'varchar', length: 255 })
  roleName!: string;

  @Column({
    name: 'role_name_ar',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  roleNameAr!: string | null;

  @Column({ name: 'role_description', type: 'text', nullable: true })
  roleDescription!: string | null;

  @Column({ name: 'is_system_role', type: 'boolean', default: false })
  isSystemRole!: boolean;

  @Column({
    name: 'status',
    type: 'enum',
    enum: TenantStatus,
    enumName: 'tenant_status',
    default: TenantStatus.ACTIVE,
  })
  status!: TenantStatus;

  @Column({ name: 'is_deleted', type: 'boolean', default: false })
  isDeleted!: boolean;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp without time zone',
    update: false,
    nullable: true,
  })
  createdAt!: Date | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamp without time zone',
    nullable: true,
  })
  updatedAt!: Date | null;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @Column({
    name: 'deleted_at',
    type: 'timestamp without time zone',
    nullable: true,
  })
  deletedAt!: Date | null;

  @Column({ name: 'deleted_by', type: 'uuid', nullable: true })
  deletedBy!: string | null;
}
