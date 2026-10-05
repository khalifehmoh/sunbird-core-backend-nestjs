import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  And,
  FindOptionsWhere,
  ILike,
  In,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import {
  InboundMessage,
  MessageAck,
  MessageError,
  MessageRetry,
  MessageTransaction,
  type AckCode,
  type MessageStatus,
} from '../emr.entities';

export type NewMessage = Pick<
  InboundMessage,
  'tenantId' | 'source' | 'rawMessage'
> &
  Partial<
    Pick<InboundMessage, 'controlId' | 'messageType' | 'sendingApplication'>
  >;

export type MessagePatch = Partial<
  Pick<
    InboundMessage,
    | 'status'
    | 'attempts'
    | 'processedAt'
    | 'messageType'
    | 'controlId'
    | 'sendingApplication'
  >
>;

export type MessageFilter = {
  status?: MessageStatus;
  messageType?: string;
  /** Matches the control id, case-insensitively. */
  q?: string;
  from?: Date;
  to?: Date;
  limit: number;
};

export type MessageCounts = {
  total: number;
  processed: number;
  failed: number;
};

export type TypeBreakdown = {
  messageType: string;
  count: number;
  failed: number;
};

export type MessageDetail = {
  transactions: MessageTransaction[];
  errors: MessageError[];
  acks: MessageAck[];
  retries: MessageRetry[];
};

/** Persistence for integration message traffic. */
export abstract class MessageStore {
  abstract createMessage(row: NewMessage): Promise<InboundMessage>;
  abstract updateMessage(messageId: string, patch: MessagePatch): Promise<void>;
  abstract getMessage(
    tenantId: string,
    messageId: string,
  ): Promise<InboundMessage | null>;
  abstract listMessages(
    tenantId: string,
    filter: MessageFilter,
  ): Promise<InboundMessage[]>;
  abstract addTransaction(row: {
    tenantId: string;
    messageId: string;
    seq: number;
    stage: string;
    status: 'OK' | 'ERROR';
    detail?: string | null;
  }): Promise<void>;
  abstract addError(row: {
    tenantId: string;
    messageId: string;
    stage: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<void>;
  abstract addAck(row: {
    tenantId: string;
    messageId: string;
    ackCode: AckCode;
    rawAck: string;
  }): Promise<void>;
  abstract addRetry(row: {
    tenantId: string;
    messageId: string;
    requestedBy: string | null;
    reason: string;
    outcome: 'SUCCESS' | 'FAILED';
  }): Promise<void>;
  abstract detail(messageId: string): Promise<MessageDetail>;
  abstract errorsFor(messageIds: string[]): Promise<MessageError[]>;
  abstract counts(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<MessageCounts>;
  abstract typeBreakdown(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<TypeBreakdown[]>;
  abstract recentErrors(
    tenantId: string,
    limit: number,
  ): Promise<MessageError[]>;
}

@Injectable()
export class TypeOrmMessageStore extends MessageStore {
  constructor(
    @InjectRepository(InboundMessage)
    private readonly messages: Repository<InboundMessage>,
    @InjectRepository(MessageTransaction)
    private readonly transactions: Repository<MessageTransaction>,
    @InjectRepository(MessageError)
    private readonly errors: Repository<MessageError>,
    @InjectRepository(MessageAck)
    private readonly acks: Repository<MessageAck>,
    @InjectRepository(MessageRetry)
    private readonly retries: Repository<MessageRetry>,
  ) {
    super();
  }

  createMessage(row: NewMessage): Promise<InboundMessage> {
    return this.messages.save(this.messages.create(row));
  }

  async updateMessage(messageId: string, patch: MessagePatch): Promise<void> {
    await this.messages.update({ messageId }, patch);
  }

  getMessage(
    tenantId: string,
    messageId: string,
  ): Promise<InboundMessage | null> {
    return this.messages.findOne({ where: { tenantId, messageId } });
  }

  listMessages(
    tenantId: string,
    filter: MessageFilter,
  ): Promise<InboundMessage[]> {
    const where: FindOptionsWhere<InboundMessage> = { tenantId };
    if (filter.status) where.status = filter.status;
    if (filter.messageType) where.messageType = filter.messageType;
    if (filter.q)
      where.controlId = ILike(`%${filter.q.replace(/[%_\\]/g, '\\$&')}%`);
    if (filter.from && filter.to) {
      where.receivedAt = And(MoreThanOrEqual(filter.from), LessThan(filter.to));
    } else if (filter.from) {
      where.receivedAt = MoreThanOrEqual(filter.from);
    } else if (filter.to) {
      where.receivedAt = LessThan(filter.to);
    }
    return this.messages.find({
      where,
      order: { receivedAt: 'DESC' },
      take: filter.limit,
    });
  }

  async addTransaction(row: Parameters<MessageStore['addTransaction']>[0]) {
    await this.transactions.save(this.transactions.create(row));
  }

  async addError(row: Parameters<MessageStore['addError']>[0]) {
    await this.errors.save(this.errors.create(row));
  }

  async addAck(row: Parameters<MessageStore['addAck']>[0]) {
    await this.acks.save(this.acks.create(row));
  }

  async addRetry(row: Parameters<MessageStore['addRetry']>[0]) {
    await this.retries.save(this.retries.create(row));
  }

  async detail(messageId: string): Promise<MessageDetail> {
    const [transactions, errors, acks, retries] = await Promise.all([
      this.transactions.find({ where: { messageId }, order: { seq: 'ASC' } }),
      this.errors.find({ where: { messageId }, order: { createdAt: 'ASC' } }),
      this.acks.find({ where: { messageId }, order: { createdAt: 'ASC' } }),
      this.retries.find({ where: { messageId }, order: { createdAt: 'ASC' } }),
    ]);
    return { transactions, errors, acks, retries };
  }

  errorsFor(messageIds: string[]): Promise<MessageError[]> {
    if (messageIds.length === 0) return Promise.resolve([]);
    return this.errors.find({
      where: { messageId: In(messageIds) },
      order: { createdAt: 'ASC' },
    });
  }

  async counts(tenantId: string, from: Date, to: Date): Promise<MessageCounts> {
    const rows = await this.messages
      .createQueryBuilder('m')
      .select('m.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('m.tenantId = :tenantId', { tenantId })
      .andWhere('m.receivedAt >= :from AND m.receivedAt < :to', { from, to })
      .groupBy('m.status')
      .getRawMany<{ status: MessageStatus; count: string }>();
    const by = (status: MessageStatus) =>
      Number(rows.find((row) => row.status === status)?.count ?? 0);
    return {
      total: rows.reduce((sum, row) => sum + Number(row.count), 0),
      processed: by('PROCESSED'),
      failed: by('FAILED'),
    };
  }

  async typeBreakdown(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<TypeBreakdown[]> {
    const rows = await this.messages
      .createQueryBuilder('m')
      .select("COALESCE(m.messageType, 'UNKNOWN')", 'messageType')
      .addSelect('COUNT(*)', 'count')
      .addSelect("COUNT(*) FILTER (WHERE m.status = 'FAILED')", 'failed')
      .where('m.tenantId = :tenantId', { tenantId })
      .andWhere('m.receivedAt >= :from AND m.receivedAt < :to', { from, to })
      .groupBy("COALESCE(m.messageType, 'UNKNOWN')")
      .orderBy('COUNT(*)', 'DESC')
      .getRawMany<{ messageType: string; count: string; failed: string }>();
    return rows.map((row) => ({
      messageType: row.messageType,
      count: Number(row.count),
      failed: Number(row.failed),
    }));
  }

  recentErrors(tenantId: string, limit: number): Promise<MessageError[]> {
    return this.errors.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
