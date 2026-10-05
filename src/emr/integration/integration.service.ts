import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { FhirAccess } from '../common/fhir-access';
import { ProcessingError } from '../common/processing-error';
import { EmrEventBus } from '../emr-events';
import { SCHEDULING } from '../emr.constants';
import type { AckCode, InboundMessage } from '../emr.entities';
import { localDayRange, localToday } from '../fhir-utils';
import { AppointmentsService } from '../appointments/appointments.service';
import { OrdersService } from '../orders/orders.service';
import { ResultsService } from '../results/results.service';
import { buildAck, parseHl7, Hl7ParseError, type Hl7Message } from './hl7';
import {
  mapOrm,
  mapOru,
  mapSiuBooking,
  mapSiuCancellation,
} from './hl7-mappers';
import { MessageStore, type MessageFilter } from './message.store';

export const MAX_MESSAGE_BYTES = 256 * 1024;

export type MessageSource = 'HL7' | 'MANUAL';

export type IngestOutcome = {
  messageId: string;
  status: 'PROCESSED' | 'FAILED';
  ackCode: AckCode;
  ack: string;
  detail: string;
};

type Handler = (
  message: Hl7Message,
  tenantId: string,
  now: Date,
) => Promise<string>;

export type MessageRow = {
  id: string;
  controlId: string | null;
  messageType: string | null;
  source: string;
  sendingApplication: string | null;
  status: InboundMessage['status'];
  attempts: number;
  receivedAt: string;
  processedAt: string | null;
  lastError: { code: string; message: string; stage: string } | null;
};

export type IntegrationKpis = {
  windowStart: string;
  windowEnd: string;
  received: number;
  processed: number;
  failed: number;
  failureRatePercent: number;
};

const toIso = (date: Date | null | undefined) =>
  date ? new Date(date).toISOString() : null;

/**
 * Inbound HL7 v2 pipeline: RECEIVED → PARSED → ROUTED → PROCESSED →
 * ACKNOWLEDGED. Every stage is recorded so a failed message can be diagnosed
 * from the monitor and replayed once the cause is fixed.
 */
@Injectable()
export class IntegrationService {
  private readonly logger = new Logger(IntegrationService.name);
  private readonly handlers: Record<string, Handler>;

  constructor(
    private readonly store: MessageStore,
    private readonly fhir: FhirAccess,
    private readonly results: ResultsService,
    private readonly orders: OrdersService,
    private readonly appointments: AppointmentsService,
    @Optional() private readonly bus?: EmrEventBus,
  ) {
    this.handlers = {
      'ORU^R01': (message, tenantId, now) =>
        this.handleResult(message, tenantId, now),
      'ORM^O01': (message, tenantId, now) =>
        this.handleOrder(message, tenantId, now),
      'SIU^S12': (message, tenantId, now) =>
        this.handleBooking(message, tenantId, now),
      'SIU^S14': (message, tenantId) =>
        this.handleCancellation(message, tenantId),
      'SIU^S15': (message, tenantId) =>
        this.handleCancellation(message, tenantId),
    };
  }

  /** Receive, process and acknowledge one message. Bad content yields a NACK, not an error. */
  async ingest(
    tenantId: string,
    raw: string,
    source: MessageSource,
    now = new Date(),
  ): Promise<IngestOutcome> {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new BadRequestException('The message body is empty');
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) {
      throw new BadRequestException(
        `The message exceeds ${MAX_MESSAGE_BYTES / 1024} KB`,
      );
    }
    const message = await this.store.createMessage({
      tenantId,
      source,
      rawMessage: raw,
    });
    await this.stage(
      message,
      1,
      'RECEIVED',
      'OK',
      `${raw.length} characters from ${source}`,
    );
    return this.process(message, 2, now);
  }

  /** Replay a FAILED message. */
  async retry(
    tenantId: string,
    messageId: string,
    userId: string | null,
    now = new Date(),
  ): Promise<IngestOutcome> {
    const message = await this.store.getMessage(tenantId, messageId);
    if (!message) throw new NotFoundException('Message not found');
    if (message.status !== 'FAILED') {
      throw new BadRequestException('Only a failed message can be retried');
    }
    const { transactions } = await this.store.detail(messageId);
    const nextSeq =
      transactions.reduce((max, t) => Math.max(max, t.seq), 0) + 1;
    await this.stage(
      message,
      nextSeq,
      'RETRY',
      'OK',
      `Attempt ${message.attempts + 1}`,
    );
    const outcome = await this.process(message, nextSeq + 1, now);
    await this.store.addRetry({
      tenantId,
      messageId,
      requestedBy: userId,
      reason: 'Manual retry',
      outcome: outcome.status === 'PROCESSED' ? 'SUCCESS' : 'FAILED',
    });
    return outcome;
  }

  async list(
    tenantId: string,
    filter: Omit<MessageFilter, 'limit'> & { limit?: number },
    now = new Date(),
  ): Promise<{ items: MessageRow[]; kpis: IntegrationKpis }> {
    const rows = await this.store.listMessages(tenantId, {
      ...filter,
      limit: Math.min(Math.max(filter.limit ?? 50, 1), 200),
    });
    const errors = await this.store.errorsFor(rows.map((r) => r.messageId));
    const lastErrorOf = new Map<string, MessageRow['lastError']>();
    for (const error of errors) {
      lastErrorOf.set(error.messageId, {
        code: error.errorCode,
        message: error.errorMessage,
        stage: error.stage,
      });
    }
    return {
      items: rows.map((row) => ({
        id: row.messageId,
        controlId: row.controlId,
        messageType: row.messageType,
        source: row.source,
        sendingApplication: row.sendingApplication,
        status: row.status,
        attempts: row.attempts,
        receivedAt: new Date(row.receivedAt).toISOString(),
        processedAt: toIso(row.processedAt),
        lastError:
          row.status === 'FAILED'
            ? (lastErrorOf.get(row.messageId) ?? null)
            : null,
      })),
      kpis: await this.kpis(tenantId, now),
    };
  }

  async get(tenantId: string, messageId: string) {
    const message = await this.store.getMessage(tenantId, messageId);
    if (!message) throw new NotFoundException('Message not found');
    const detail = await this.store.detail(messageId);
    return {
      id: message.messageId,
      controlId: message.controlId,
      messageType: message.messageType,
      source: message.source,
      sendingApplication: message.sendingApplication,
      status: message.status,
      attempts: message.attempts,
      receivedAt: new Date(message.receivedAt).toISOString(),
      processedAt: toIso(message.processedAt),
      rawMessage: message.rawMessage,
      stages: detail.transactions.map((t) => ({
        seq: t.seq,
        stage: t.stage,
        status: t.status,
        detail: t.detail,
        at: new Date(t.createdAt).toISOString(),
      })),
      errors: detail.errors.map((e) => ({
        stage: e.stage,
        code: e.errorCode,
        message: e.errorMessage,
        at: new Date(e.createdAt).toISOString(),
      })),
      acks: detail.acks.map((a) => ({
        code: a.ackCode,
        raw: a.rawAck,
        at: new Date(a.createdAt).toISOString(),
      })),
      retries: detail.retries.map((r) => ({
        requestedBy: r.requestedBy,
        reason: r.reason,
        outcome: r.outcome,
        at: new Date(r.createdAt).toISOString(),
      })),
    };
  }

  /** Today's traffic, as shown on the monitor and the IT dashboard. */
  async kpis(tenantId: string, now = new Date()): Promise<IntegrationKpis> {
    const { start, end } = localDayRange(
      localToday(SCHEDULING.utcOffsetMinutes, now),
      SCHEDULING.utcOffsetMinutes,
    );
    const counts = await this.store.counts(
      tenantId,
      new Date(start),
      new Date(end),
    );
    return {
      windowStart: start,
      windowEnd: end,
      received: counts.total,
      processed: counts.processed,
      failed: counts.failed,
      failureRatePercent:
        counts.total === 0
          ? 0
          : Math.round((counts.failed / counts.total) * 1000) / 10,
    };
  }

  async stats(tenantId: string, now = new Date()) {
    const kpis = await this.kpis(tenantId, now);
    const [byType, recentErrors] = await Promise.all([
      this.store.typeBreakdown(
        tenantId,
        new Date(kpis.windowStart),
        new Date(kpis.windowEnd),
      ),
      this.store.recentErrors(tenantId, 5),
    ]);
    return {
      ...kpis,
      byType,
      recentErrors: recentErrors.map((e) => ({
        messageId: e.messageId,
        stage: e.stage,
        code: e.errorCode,
        message: e.errorMessage,
        at: new Date(e.createdAt).toISOString(),
      })),
    };
  }

  // ---------------------------------------------------------------- pipeline

  private async process(
    message: InboundMessage,
    firstSeq: number,
    now: Date,
  ): Promise<IngestOutcome> {
    let seq = firstSeq;
    const { tenantId, messageId } = message;
    const attempts = message.attempts + 1;
    let parsed: Hl7Message | undefined;

    const finish = async (
      status: 'PROCESSED' | 'FAILED',
      ackCode: AckCode,
      detail: string,
    ): Promise<IngestOutcome> => {
      const ack = buildAck(parsed, ackCode, detail, now);
      await this.store.addAck({ tenantId, messageId, ackCode, rawAck: ack });
      await this.stage(
        message,
        seq++,
        'ACKNOWLEDGED',
        'OK',
        `${ackCode}: ${detail}`,
      );
      await this.store.updateMessage(messageId, {
        status,
        attempts,
        processedAt: new Date(),
      });
      return { messageId, status, ackCode, ack, detail };
    };

    const fail = async (
      stage: string,
      code: string,
      description: string,
      ackCode: AckCode,
    ): Promise<IngestOutcome> => {
      await this.stage(
        message,
        seq++,
        stage,
        'ERROR',
        `${code}: ${description}`,
      );
      await this.store.addError({
        tenantId,
        messageId,
        stage,
        errorCode: code,
        errorMessage: description,
      });
      this.bus?.publish({
        channel: 'emr.error',
        event: code,
        tenantId,
        data: { messageId, stage, message: description },
      });
      return finish('FAILED', ackCode, `${code}: ${description}`);
    };

    try {
      parsed = parseHl7(message.rawMessage);
    } catch (error) {
      if (error instanceof Hl7ParseError) {
        return fail('PARSED', 'INVALID_HL7', error.message, 'AR');
      }
      throw error;
    }
    await this.store.updateMessage(messageId, {
      messageType: parsed.messageType,
      controlId: parsed.controlId,
      sendingApplication: parsed.sendingApplication || null,
    });
    await this.stage(
      message,
      seq++,
      'PARSED',
      'OK',
      `${parsed.messageType} ${parsed.controlId}`,
    );

    const handler = this.handlers[parsed.messageType];
    if (!handler) {
      return fail(
        'ROUTED',
        'UNSUPPORTED_MESSAGE_TYPE',
        `${parsed.messageType} is not supported`,
        'AR',
      );
    }
    await this.stage(message, seq++, 'ROUTED', 'OK', parsed.messageType);

    let detail: string;
    try {
      detail = await handler(parsed, tenantId, now);
    } catch (error) {
      if (error instanceof ProcessingError) {
        return fail('PROCESSED', error.code, error.message, 'AE');
      }
      if (error instanceof HttpException) {
        return fail('PROCESSED', 'PROCESSING_FAILED', error.message, 'AE');
      }
      // Unknown failures (e.g. Medplum unreachable): keep the detail in the
      // server log, not in a message the sender can read back.
      this.logger.error(
        `Message ${messageId} failed unexpectedly: ${String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return fail(
        'PROCESSED',
        'INTERNAL_ERROR',
        'The message could not be processed; it can be retried',
        'AE',
      );
    }
    await this.stage(message, seq++, 'PROCESSED', 'OK', detail);
    return finish('PROCESSED', 'AA', detail);
  }

  private stage(
    message: InboundMessage,
    seq: number,
    stage: string,
    status: 'OK' | 'ERROR',
    detail: string,
  ) {
    return this.store.addTransaction({
      tenantId: message.tenantId,
      messageId: message.messageId,
      seq,
      stage,
      status,
      detail,
    });
  }

  // ---------------------------------------------------------------- handlers

  private async patientIdFor(mrn: string, tenantId: string): Promise<string> {
    const id = await this.fhir.findPatientIdByMrn(mrn, tenantId);
    if (!id) {
      throw new ProcessingError(
        'PATIENT_NOT_FOUND',
        `No patient has MRN ${mrn}`,
      );
    }
    return id;
  }

  private async handleResult(message: Hl7Message, tenantId: string, now: Date) {
    const { mrn, groups } = mapOru(message);
    const patientId = await this.patientIdFor(mrn, tenantId);
    let stored = 0;
    let duplicates = 0;
    let critical = 0;
    for (const group of groups) {
      const outcome = await this.results.ingest(
        { ...group, patientId, source: 'HL7' },
        tenantId,
        now,
      );
      if (outcome.duplicate) duplicates += 1;
      else stored += 1;
      if (outcome.critical) critical += 1;
    }
    return (
      `${stored} report(s) stored` +
      (duplicates > 0 ? `, ${duplicates} already received` : '') +
      (critical > 0 ? `, ${critical} critical` : '')
    );
  }

  private async handleOrder(message: Hl7Message, tenantId: string, now: Date) {
    const order = mapOrm(message);
    if (order.control === 'NW') {
      const patientId = await this.patientIdFor(order.mrn, tenantId);
      const outcome = await this.orders.createInbound(
        { ...order, patientId },
        tenantId,
        now,
      );
      return outcome.duplicate
        ? `Order ${outcome.orderNumber} already exists`
        : `Order ${outcome.orderNumber} created`;
    }
    const outcome = await this.orders.cancelInbound(
      order.orderNumber ?? '',
      order.reason ?? 'Cancelled by the ordering system',
      tenantId,
    );
    return outcome.duplicate
      ? `Order ${order.orderNumber} was already cancelled`
      : `Order ${order.orderNumber} cancelled`;
  }

  private async handleBooking(
    message: Hl7Message,
    tenantId: string,
    now: Date,
  ) {
    const booking = mapSiuBooking(message);
    const patientId = await this.patientIdFor(booking.mrn, tenantId);
    const outcome = await this.appointments.bookInbound(
      { ...booking, patientId },
      tenantId,
      now,
    );
    return outcome.duplicate
      ? `Appointment ${booking.externalId} already booked`
      : `Appointment ${booking.externalId} booked`;
  }

  private async handleCancellation(message: Hl7Message, tenantId: string) {
    const cancellation = mapSiuCancellation(message);
    const outcome = await this.appointments.cancelInbound(
      cancellation.externalId,
      cancellation.reason,
      tenantId,
    );
    return outcome.duplicate
      ? `Appointment ${cancellation.externalId} was already cancelled`
      : `Appointment ${cancellation.externalId} cancelled`;
  }
}
