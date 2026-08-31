import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TenantStatus } from '../../tenants/tenant-status.enum';
import { Tenant } from './tenant.entity';
import { GroupMember } from './group-member.entity';
import { GroupRole } from './group-role.entity';

@Entity({ name: 'groups', schema: 'core' })
export class Group {
  @PrimaryGeneratedColumn('uuid', { name: 'group_id' })
  groupId!: string;

  @ManyToOne(() => Tenant, { nullable: false })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @Column({ name: 'group_code', type: 'varchar', length: 50 })
  groupCode!: string;

  @Column({ name: 'group_name', type: 'varchar', length: 255 })
  groupName!: string;

  @Column({
    name: 'group_name_ar',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  groupNameAr!: string | null;

  @Column({ name: 'group_description', type: 'text', nullable: true })
  groupDescription!: string | null;

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

  @OneToMany(() => GroupMember, (member) => member.group)
  members!: GroupMember[];

  @OneToMany(() => GroupRole, (role) => role.group)
  roles!: GroupRole[];
}
