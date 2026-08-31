import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ModuleEntity } from './module.entity';

@Entity({ name: 'permissions', schema: 'core' })
export class Permission {
  @PrimaryGeneratedColumn('uuid', { name: 'permission_id' })
  permissionId!: string;

  @ManyToOne(() => ModuleEntity, (module) => module.permissions, {
    nullable: false,
  })
  @JoinColumn({ name: 'module_id' })
  module!: ModuleEntity;

  @Column({ name: 'permission_code', type: 'varchar', length: 50 })
  permissionCode!: string;

  @Column({ name: 'permission_name', type: 'varchar', length: 255 })
  permissionName!: string;

  @Column({
    name: 'permission_name_ar',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  permissionNameAr!: string | null;

  @Column({ name: 'operation', type: 'varchar', length: 50 })
  operation!: string;

  @Column({ name: 'permission_description', type: 'text', nullable: true })
  permissionDescription!: string | null;

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
