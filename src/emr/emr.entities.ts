import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';

const TIMESTAMP = 'timestamp without time zone' as const;

export type NotificationChannel = 'SMS' | 'WHATSAPP' | 'EMAIL';
export type NotificationLanguage = 'en' | 'ar';
export type NotificationStatus = 'PENDING' | 'SENT' | 'FAILED';

@Entity({ name: 'emr_sequences', schema: 'core' })
export class EmrSequence {
  @PrimaryColumn('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'varchar', length: 60 })
  name!: string;

  @Column({ type: 'bigint', transformer: bigintAsNumber() })
  value!: number;
}

@Entity({ name: 'emr_notif_template', schema: 'core' })
@Index(['tenantId', 'eventCode', 'language', 'channel'], { unique: true })
export class NotificationTemplate {
  @PrimaryGeneratedColumn('uuid', { name: 'template_id' })
  templateId!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column({ name: 'event_code', type: 'varchar', length: 60 })
  eventCode!: string;

  @Column({ type: 'varchar', length: 5 })
  language!: NotificationLanguage;

  @Column({ type: 'varchar', length: 20 })
  channel!: NotificationChannel;

  @Column({ type: 'varchar', length: 255, nullable: true })
  subject!: string | null;

  @Column({ type: 'text' })
  body!: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP, update: false })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: TIMESTAMP, default: () => 'now()' })
  updatedAt!: Date;

  @Column('uuid', { name: 'updated_by', nullable: true })
  updatedBy!: string | null;
}

@Entity({ name: 'emr_notif_log', schema: 'core' })
export class NotificationLog {
  @PrimaryGeneratedColumn('uuid', { name: 'notif_id' })
  notifId!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'template_id', nullable: true })
  templateId!: string | null;

  @Column({ name: 'event_code', type: 'varchar', length: 60 })
  eventCode!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: NotificationChannel;

  @Column({ type: 'varchar', length: 5 })
  language!: NotificationLanguage;

  @Column({ type: 'varchar', length: 100, nullable: true })
  recipient!: string | null;

  @Column({ name: 'patient_id', type: 'varchar', length: 64, nullable: true })
  patientId!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  resource!: string | null;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'varchar', length: 10, default: 'PENDING' })
  status!: NotificationStatus;

  @Column({ type: 'varchar', length: 30, nullable: true })
  provider!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP, update: false })
  createdAt!: Date;

  @Column({ name: 'sent_at', type: TIMESTAMP, nullable: true })
  sentAt!: Date | null;
}

export type MessageStatus = 'RECEIVED' | 'PROCESSED' | 'FAILED';

@Entity({ name: 'emr_msg_inbound', schema: 'core' })
export class InboundMessage {
  @PrimaryGeneratedColumn('uuid', { name: 'message_id' })
  messageId!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column({ name: 'control_id', type: 'varchar', length: 100, nullable: true })
  controlId!: string | null;

  @Column({
    name: 'message_type',
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  messageType!: string | null;

  @Column({ type: 'varchar', length: 30 })
  source!: string;

  @Column({
    name: 'sending_application',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  sendingApplication!: string | null;

  @Column({ name: 'raw_message', type: 'text' })
  rawMessage!: string;

  @Column({ type: 'varchar', length: 12, default: 'RECEIVED' })
  status!: MessageStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @CreateDateColumn({ name: 'received_at', type: TIMESTAMP, update: false })
  receivedAt!: Date;

  @Column({ name: 'processed_at', type: TIMESTAMP, nullable: true })
  processedAt!: Date | null;
}

@Entity({ name: 'emr_msg_transaction', schema: 'core' })
export class MessageTransaction {
  @PrimaryGeneratedColumn('uuid', { name: 'transaction_id' })
  transactionId!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'message_id' })
  messageId!: string;

  @Column({ type: 'int' })
  seq!: number;

  @Column({ type: 'varchar', length: 30 })
  stage!: string;

  @Column({ type: 'varchar', length: 10 })
  status!: 'OK' | 'ERROR';

  @Column({ type: 'text', nullable: true })
  detail!: string | null;

  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP, update: false })
  createdAt!: Date;
}

@Entity({ name: 'emr_msg_error', schema: 'core' })
export class MessageError {
  @PrimaryGeneratedColumn('uuid', { name: 'error_id' })
  errorId!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'message_id' })
  messageId!: string;

  @Column({ type: 'varchar', length: 30 })
  stage!: string;

  @Column({ name: 'error_code', type: 'varchar', length: 60 })
  errorCode!: string;

  @Column({ name: 'error_message', type: 'text' })
  errorMessage!: string;

  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP, update: false })
  createdAt!: Date;
}

export type AckCode = 'AA' | 'AE' | 'AR';

@Entity({ name: 'emr_msg_ack', schema: 'core' })
export class MessageAck {
  @PrimaryGeneratedColumn('uuid', { name: 'ack_id' })
  ackId!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'message_id' })
  messageId!: string;

  @Column({ name: 'ack_code', type: 'varchar', length: 2 })
  ackCode!: AckCode;

  @Column({ name: 'raw_ack', type: 'text' })
  rawAck!: string;

  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP, update: false })
  createdAt!: Date;
}

@Entity({ name: 'emr_msg_retry', schema: 'core' })
export class MessageRetry {
  @PrimaryGeneratedColumn('uuid', { name: 'retry_id' })
  retryId!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'message_id' })
  messageId!: string;

  @Column('uuid', { name: 'requested_by', nullable: true })
  requestedBy!: string | null;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'varchar', length: 10 })
  outcome!: 'SUCCESS' | 'FAILED';

  @CreateDateColumn({ name: 'created_at', type: TIMESTAMP, update: false })
  createdAt!: Date;
}

/** Postgres returns `bigint` as a string; sequences stay far below 2^53. */
function bigintAsNumber() {
  return {
    to: (value: number) => value,
    from: (value: string | null) => (value === null ? 0 : Number(value)),
  };
}

export const EMR_ENTITIES = [
  EmrSequence,
  NotificationTemplate,
  NotificationLog,
  InboundMessage,
  MessageTransaction,
  MessageError,
  MessageAck,
  MessageRetry,
];
