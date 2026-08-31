import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Group } from './group.entity';
import { Role } from './role.entity';

@Entity({ name: 'group_roles', schema: 'core' })
export class GroupRole {
  @PrimaryGeneratedColumn('uuid', { name: 'group_role_id' })
  groupRoleId!: string;

  @ManyToOne(() => Group, (group) => group.roles, { nullable: false })
  @JoinColumn({ name: 'group_id' })
  group!: Group;

  @ManyToOne(() => Role, { nullable: false })
  @JoinColumn({ name: 'role_id' })
  role!: Role;

  @CreateDateColumn({
    name: 'assigned_at',
    type: 'timestamp without time zone',
    update: false,
    nullable: true,
  })
  assignedAt!: Date | null;

  @Column({ name: 'assigned_by', type: 'uuid', nullable: true })
  assignedBy!: string | null;

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

  @Column({
    name: 'deleted_at',
    type: 'timestamp without time zone',
    nullable: true,
  })
  deletedAt!: Date | null;

  @Column({ name: 'deleted_by', type: 'uuid', nullable: true })
  deletedBy!: string | null;
}
