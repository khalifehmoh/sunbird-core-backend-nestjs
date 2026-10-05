import {
  InboundMessage,
  MessageAck,
  MessageError,
  MessageRetry,
  MessageTransaction,
} from '../emr.entities';
import {
  MessageStore,
  type MessageCounts,
  type MessageDetail,
  type MessageFilter,
  type MessagePatch,
  type NewMessage,
  type TypeBreakdown,
} from '../integration/message.store';

/** In-memory {@link MessageStore} for specs. */
export class InMemoryMessageStore extends MessageStore {
  readonly messages: InboundMessage[] = [];
  readonly transactions: MessageTransaction[] = [];
  readonly errors: MessageError[] = [];
  readonly acks: MessageAck[] = [];
  readonly retries: MessageRetry[] = [];
  private next = 0;
  private clock = 0;

  createMessage(row: NewMessage): Promise<InboundMessage> {
    const message: InboundMessage = {
      messageId: `msg-${++this.next}`,
      tenantId: row.tenantId,
      controlId: row.controlId ?? null,
      messageType: row.messageType ?? null,
      source: row.source,
      sendingApplication: row.sendingApplication ?? null,
      rawMessage: row.rawMessage,
      status: 'RECEIVED',
      attempts: 0,
      receivedAt: this.tick(),
      processedAt: null,
    };
    this.messages.push(message);
    return Promise.resolve({ ...message });
  }

  updateMessage(messageId: string, patch: MessagePatch): Promise<void> {
    const message = this.messages.find((m) => m.messageId === messageId);
    if (message) Object.assign(message, patch);
    return Promise.resolve();
  }

  getMessage(
    tenantId: string,
    messageId: string,
  ): Promise<InboundMessage | null> {
    const found = this.messages.find(
      (m) => m.tenantId === tenantId && m.messageId === messageId,
    );
    return Promise.resolve(found ? { ...found } : null);
  }

  listMessages(
    tenantId: string,
    filter: MessageFilter,
  ): Promise<InboundMessage[]> {
    const q = filter.q?.toLowerCase();
    return Promise.resolve(
      this.messages
        .filter(
          (m) =>
            m.tenantId === tenantId &&
            (!filter.status || m.status === filter.status) &&
            (!filter.messageType || m.messageType === filter.messageType) &&
            (!q || (m.controlId ?? '').toLowerCase().includes(q)) &&
            (!filter.from || m.receivedAt >= filter.from) &&
            (!filter.to || m.receivedAt < filter.to),
        )
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
        .slice(0, filter.limit)
        .map((m) => ({ ...m })),
    );
  }

  addTransaction(
    row: Parameters<MessageStore['addTransaction']>[0],
  ): Promise<void> {
    this.transactions.push({
      ...row,
      detail: row.detail ?? null,
      transactionId: `tx-${++this.next}`,
      createdAt: this.tick(),
    });
    return Promise.resolve();
  }

  addError(row: Parameters<MessageStore['addError']>[0]): Promise<void> {
    this.errors.push({
      ...row,
      errorId: `err-${++this.next}`,
      createdAt: this.tick(),
    });
    return Promise.resolve();
  }

  addAck(row: Parameters<MessageStore['addAck']>[0]): Promise<void> {
    this.acks.push({
      ...row,
      ackId: `ack-${++this.next}`,
      createdAt: this.tick(),
    });
    return Promise.resolve();
  }

  addRetry(row: Parameters<MessageStore['addRetry']>[0]): Promise<void> {
    this.retries.push({
      ...row,
      retryId: `retry-${++this.next}`,
      createdAt: this.tick(),
    });
    return Promise.resolve();
  }

  detail(messageId: string): Promise<MessageDetail> {
    const mine = <T extends { messageId: string }>(rows: T[]) =>
      rows.filter((r) => r.messageId === messageId);
    return Promise.resolve({
      transactions: mine(this.transactions).sort((a, b) => a.seq - b.seq),
      errors: mine(this.errors),
      acks: mine(this.acks),
      retries: mine(this.retries),
    });
  }

  errorsFor(messageIds: string[]): Promise<MessageError[]> {
    return Promise.resolve(
      this.errors.filter((e) => messageIds.includes(e.messageId)),
    );
  }

  counts(tenantId: string, from: Date, to: Date): Promise<MessageCounts> {
    const rows = this.inWindow(tenantId, from, to);
    return Promise.resolve({
      total: rows.length,
      processed: rows.filter((m) => m.status === 'PROCESSED').length,
      failed: rows.filter((m) => m.status === 'FAILED').length,
    });
  }

  typeBreakdown(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<TypeBreakdown[]> {
    const byType = new Map<string, TypeBreakdown>();
    for (const m of this.inWindow(tenantId, from, to)) {
      const key = m.messageType ?? 'UNKNOWN';
      const entry = byType.get(key) ?? {
        messageType: key,
        count: 0,
        failed: 0,
      };
      entry.count += 1;
      if (m.status === 'FAILED') entry.failed += 1;
      byType.set(key, entry);
    }
    return Promise.resolve(
      [...byType.values()].sort((a, b) => b.count - a.count),
    );
  }

  recentErrors(tenantId: string, limit: number): Promise<MessageError[]> {
    return Promise.resolve(
      this.errors
        .filter((e) => e.tenantId === tenantId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit),
    );
  }

  private inWindow(tenantId: string, from: Date, to: Date): InboundMessage[] {
    return this.messages.filter(
      (m) =>
        m.tenantId === tenantId && m.receivedAt >= from && m.receivedAt < to,
    );
  }

  private tick(): Date {
    return new Date(Date.UTC(2026, 9, 6, 9, 0, ++this.clock));
  }
}
