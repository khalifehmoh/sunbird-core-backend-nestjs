import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TenantStatus } from '../../tenants/tenant-status.enum';
import { Permission } from './permission.entity';

@Entity({ name: 'modules', schema: 'core' })
export class ModuleEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'module_id' })
  moduleId!: string;

  @Column({ name: 'module_code', type: 'varchar', length: 50 })
  moduleCode!: string;

  @Column({ name: 'module_name', type: 'varchar', length: 255 })
  moduleName!: string;

  @Column({
    name: 'module_name_ar',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  moduleNameAr!: string | null;

  @Column({ name: 'module_description', type: 'text', nullable: true })
  moduleDescription!: string | null;

  @Column({ name: 'is_system_module', type: 'boolean', default: false })
  isSystemModule!: boolean;

  @Column({ name: 'display_order', type: 'int', nullable: true })
  displayOrder!: number | null;

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

  @OneToMany(() => Permission, (permission) => permission.module)
  permissions!: Permission[];
}
