import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Group } from './group.entity';
import { User } from './user.entity';

@Entity({ name: 'group_members', schema: 'core' })
export class GroupMember {
  @PrimaryGeneratedColumn('uuid', { name: 'member_id' })
  memberId!: string;

  @ManyToOne(() => Group, (group) => group.members, { nullable: false })
  @JoinColumn({ name: 'group_id' })
  group!: Group;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @CreateDateColumn({
    name: 'joined_at',
    type: 'timestamp without time zone',
    update: false,
    nullable: true,
  })
  joinedAt!: Date | null;

  @Column({ name: 'joined_by', type: 'uuid', nullable: true })
  joinedBy!: string | null;

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
