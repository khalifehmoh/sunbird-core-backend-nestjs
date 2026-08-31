import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Tenant } from './tenant.entity';
import { BranchStatus } from '../../branches/branch-status.enum';

@Entity({ name: 'branches', schema: 'core' })
export class Branch {
  @PrimaryGeneratedColumn('uuid', { name: 'branch_id' })
  branchId!: string;

  @ManyToOne(() => Tenant, { nullable: false })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @Column({ name: 'branch_code', type: 'varchar', length: 50 })
  branchCode!: string;

  @Column({ name: 'branch_name', type: 'varchar', length: 255 })
  branchName!: string;

  @Column({
    name: 'branch_name_ar',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  branchNameAr!: string | null;

  @Column({ name: 'branch_type', type: 'varchar', length: 50, nullable: true })
  branchType!: string | null;

  @Column({
    name: 'license_number',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  licenseNumber!: string | null;

  @Column({
    name: 'contact_email',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  contactEmail!: string | null;

  @Column({
    name: 'contact_phone',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  contactPhone!: string | null;

  @Column({ name: 'address', type: 'text', nullable: true })
  address!: string | null;

  @Column({ name: 'city', type: 'varchar', length: 100, nullable: true })
  city!: string | null;

  @Column({ name: 'region', type: 'varchar', length: 100, nullable: true })
  region!: string | null;

  @Column({ name: 'is_headquarters', type: 'boolean', default: false })
  isHeadquarters!: boolean;

  @Column({
    name: 'status',
    type: 'enum',
    enum: BranchStatus,
    enumName: 'tenant_status',
    default: BranchStatus.ACTIVE,
  })
  status!: BranchStatus;

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
