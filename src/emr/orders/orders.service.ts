import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Patient, ServiceRequest } from '@medplum/fhirtypes';
import { updateEntry } from '../../fhir/fhir-transaction';
import { systemActor, type MedplumActor } from '../../fhir/medplum-actor';
import { FhirAccess } from '../common/fhir-access';
import { ProcessingError } from '../common/processing-error';
import {
  ENTRY_SOURCE_SYSTEM,
  type EntrySource,
  LOINC_SYSTEM,
  ORDER_NUMBER_SYSTEM,
  ORM_EVENT_SYSTEM,
  SNOMED_SYSTEM,
} from '../emr.constants';
import { EmrEventBus } from '../emr-events';
import {
  dateRange,
  idOfReference,
  indexById,
  mrnOf,
  patientNames,
  referenceTo,
  resourcesOf,
  searchBundle,
  withTag,
} from '../fhir-utils';
import { SequenceService } from '../sequence.service';
import { catalogEntry } from './order-catalog';
import {
  ORDER_PRIORITIES,
  type CreateOrderDto,
  type OrderPriority,
  type OrderRow,
  type OrderType,
  type OrdersQueryDto,
} from './orders.dto';

const DEFAULT_LIMIT = 100;

const TYPE_CATEGORY: Record<OrderType, { code: string; display: string }> = {
  LAB: { code: '108252007', display: 'Laboratory procedure' },
  RAD: { code: '363679005', display: 'Imaging' },
};

const CANCELLABLE: readonly string[] = ['draft', 'active', 'on-hold'];

const FHIR_PRIORITY: Record<OrderPriority, ServiceRequest['priority']> = {
  ROUTINE: 'routine',
  URGENT: 'urgent',
  STAT: 'stat',
};

/** LAB / RAD orders (HL7 ORM) as FHIR ServiceRequests. */
@Injectable()
export class OrdersService {
  constructor(
    private readonly fhir: FhirAccess,
    private readonly sequences: SequenceService,
    @Optional() private readonly bus?: EmrEventBus,
  ) {}

  async create(
    dto: CreateOrderDto,
    actor: MedplumActor,
    now = new Date(),
    options: { orderNumber?: string; source?: EntrySource } = {},
  ): Promise<OrderRow> {
    const known = catalogEntry(dto.code);
    const display = dto.display ?? known?.display;
    if (!display) {
      throw new BadRequestException(
        'display is required for a code that is not in the order catalog',
      );
    }
    if (known && known.type !== dto.type) {
      throw new BadRequestException(
        `${dto.code} is a ${known.type} code, not ${dto.type}`,
      );
    }

    const patient = await this.fhir.readPatient(dto.patientId, actor);
    if (dto.encounterId) {
      await this.fhir.readEncounterOf(dto.encounterId, dto.patientId, actor);
    }

    const orderNumber =
      options.orderNumber ?? (await this.nextOrderNumber(actor, now));
    const category = TYPE_CATEGORY[dto.type];
    const requester = this.fhir.performerOf(actor);
    const order: ServiceRequest = {
      resourceType: 'ServiceRequest',
      identifier: [{ system: ORDER_NUMBER_SYSTEM, value: orderNumber }],
      status: 'active',
      intent: 'order',
      priority: FHIR_PRIORITY[dto.priority ?? 'ROUTINE'],
      category: [
        {
          coding: [
            {
              system: SNOMED_SYSTEM,
              code: category.code,
              display: category.display,
            },
          ],
        },
      ],
      code: {
        coding: [{ system: LOINC_SYSTEM, code: dto.code, display }],
        text: display,
      },
      subject: referenceTo('Patient', dto.patientId),
      ...(dto.encounterId
        ? { encounter: referenceTo('Encounter', dto.encounterId) }
        : {}),
      authoredOn: now.toISOString(),
      ...(requester ? { requester } : {}),
      ...(dto.notes ? { note: [{ text: dto.notes }] } : {}),
      meta: {
        tag: [
          { system: ORM_EVENT_SYSTEM, code: 'O01' },
          { system: ENTRY_SOURCE_SYSTEM, code: options.source ?? 'MANUAL' },
        ],
      },
    };

    const created = await this.fhir.client(actor).createResource(order);
    this.bus?.publish({
      channel: 'emr.orm',
      event: 'O01',
      tenantId: actor.tenantId,
      actor,
      patientId: dto.patientId,
      resource: `ServiceRequest/${created.id}`,
      data: { orderNumber, type: dto.type, display },
    });
    return this.toRow(created, new Map([[dto.patientId, patient]]));
  }

  async list(
    query: OrdersQueryDto,
    actor: MedplumActor,
  ): Promise<{ items: OrderRow[] }> {
    const bundle = await searchBundle(
      this.fhir.client(actor),
      'ServiceRequest',
      {
        category: query.type ? TYPE_CATEGORY[query.type].code : undefined,
        status: query.status,
        priority: query.priority ? FHIR_PRIORITY[query.priority] : undefined,
        subject: query.patientId ? `Patient/${query.patientId}` : undefined,
        encounter: query.encounterId
          ? `Encounter/${query.encounterId}`
          : undefined,
        authored: dateRange(query.from, query.to),
        _include: 'ServiceRequest:subject',
        _sort: '-authored',
        _count: query.limit ?? DEFAULT_LIMIT,
      },
    );
    const patients = indexById<Patient>(bundle, 'Patient');
    return {
      items: resourcesOf<ServiceRequest>(bundle, 'ServiceRequest').map(
        (order) => this.toRow(order, patients),
      ),
    };
  }

  async get(id: string, actor: MedplumActor): Promise<OrderRow> {
    const order = await this.fhir.read<ServiceRequest>(
      'ServiceRequest',
      id,
      actor,
    );
    const patientId = idOfReference(order.subject?.reference, 'Patient');
    const patient = patientId
      ? await this.fhir.readPatient(patientId, actor).catch(() => undefined)
      : undefined;
    return this.toRow(
      order,
      new Map(patient && patientId ? [[patientId, patient]] : []),
    );
  }

  async cancel(
    id: string,
    reason: string,
    actor: MedplumActor,
  ): Promise<OrderRow> {
    const order = await this.fhir.read<ServiceRequest>(
      'ServiceRequest',
      id,
      actor,
    );
    if (!CANCELLABLE.includes(order.status)) {
      throw new BadRequestException(
        `A ${order.status} order cannot be cancelled`,
      );
    }
    const cancelled: ServiceRequest = {
      ...order,
      status: 'revoked',
      note: [...(order.note ?? []), { text: `Cancelled: ${reason}` }],
      meta: {
        ...order.meta,
        tag: withTag(order, ORM_EVENT_SYSTEM, 'O01-CANCEL'),
      },
    };
    const result = await this.fhir.commit(
      actor,
      [updateEntry(cancelled)],
      'The order changed while it was being cancelled. Reload and try again.',
    );
    const saved =
      (result.entry?.[0]?.resource as ServiceRequest | undefined) ?? cancelled;

    const patientId = idOfReference(saved.subject?.reference, 'Patient');
    this.bus?.publish({
      channel: 'emr.orm',
      event: 'O01-CANCEL',
      tenantId: actor.tenantId,
      actor,
      patientId,
      resource: `ServiceRequest/${id}`,
      data: { reason },
    });
    const patient = patientId
      ? await this.fhir.readPatient(patientId, actor).catch(() => undefined)
      : undefined;
    return this.toRow(
      saved,
      new Map(patient && patientId ? [[patientId, patient]] : []),
    );
  }

  /**
   * ORM^O01 NW from an external system. The sender's placer order number is
   * kept as the order number, so redelivery finds the order it already made.
   */
  async createInbound(
    input: {
      patientId: string;
      orderNumber?: string;
      code: string;
      display: string;
      type: OrderType;
      priority: OrderPriority;
    },
    tenantId: string,
    now = new Date(),
  ): Promise<{ orderId: string; orderNumber: string; duplicate: boolean }> {
    const actor = systemActor(tenantId);
    if (input.orderNumber) {
      const existing = await this.findByNumber(input.orderNumber, actor);
      if (existing?.id) {
        return {
          orderId: existing.id,
          orderNumber: input.orderNumber,
          duplicate: true,
        };
      }
    }
    try {
      const row = await this.create(
        {
          patientId: input.patientId,
          type: input.type,
          code: input.code,
          display: input.display,
          priority: input.priority,
        },
        actor,
        now,
        { orderNumber: input.orderNumber, source: 'HL7' },
      );
      return {
        orderId: row.id,
        orderNumber: row.orderNumber ?? '',
        duplicate: false,
      };
    } catch (error) {
      throw this.asProcessingError(error);
    }
  }

  /** ORM^O01 CA / DC from an external system. */
  async cancelInbound(
    orderNumber: string,
    reason: string,
    tenantId: string,
  ): Promise<{ orderId: string; duplicate: boolean }> {
    const actor = systemActor(tenantId);
    const order = await this.findByNumber(orderNumber, actor);
    if (!order?.id) {
      throw new ProcessingError(
        'ORDER_NOT_FOUND',
        `No order ${orderNumber} exists`,
      );
    }
    if (order.status === 'revoked')
      return { orderId: order.id, duplicate: true };
    try {
      await this.cancel(order.id, reason, actor);
      return { orderId: order.id, duplicate: false };
    } catch (error) {
      throw this.asProcessingError(error);
    }
  }

  private async findByNumber(
    orderNumber: string,
    actor: MedplumActor,
  ): Promise<ServiceRequest | undefined> {
    return resourcesOf<ServiceRequest>(
      await searchBundle(this.fhir.client(actor), 'ServiceRequest', {
        identifier: `${ORDER_NUMBER_SYSTEM}|${orderNumber}`,
        _count: 1,
      }),
      'ServiceRequest',
    )[0];
  }

  private asProcessingError(error: unknown): unknown {
    if (error instanceof ProcessingError) return error;
    if (error instanceof NotFoundException) {
      return new ProcessingError('REFERENCE_NOT_FOUND', error.message);
    }
    if (error instanceof BadRequestException) {
      return new ProcessingError('INVALID_ORDER', error.message);
    }
    return error;
  }

  private async nextOrderNumber(
    actor: MedplumActor,
    now: Date,
  ): Promise<string> {
    const year = now.getUTCFullYear();
    const sequence = await this.sequences.next(actor.tenantId, `order:${year}`);
    return `ORD-${year}-${String(sequence).padStart(5, '0')}`;
  }

  private toRow(
    order: ServiceRequest,
    patients: Map<string, Patient>,
  ): OrderRow {
    const patientId = idOfReference(order.subject?.reference, 'Patient');
    const patient = patientId ? patients.get(patientId) : undefined;
    const categoryCode = order.category
      ?.flatMap((category) => category.coding ?? [])
      .find((coding) => coding.system === SNOMED_SYSTEM)?.code;
    const type =
      (Object.entries(TYPE_CATEGORY).find(
        ([, category]) => category.code === categoryCode,
      )?.[0] as OrderType | undefined) ?? null;
    const coding = order.code?.coding?.[0];
    const priority =
      ORDER_PRIORITIES.find(
        (candidate) => FHIR_PRIORITY[candidate] === order.priority,
      ) ?? 'ROUTINE';

    return {
      id: order.id ?? '',
      orderNumber:
        order.identifier?.find((id) => id.system === ORDER_NUMBER_SYSTEM)
          ?.value ?? null,
      type,
      code: coding?.code ?? null,
      display: coding?.display ?? order.code?.text ?? null,
      priority,
      status: order.status,
      patientId: patientId ?? null,
      patientName: patient ? patientNames(patient).name : null,
      mrn: mrnOf(patient),
      encounterId:
        idOfReference(order.encounter?.reference, 'Encounter') ?? null,
      orderedAt: order.authoredOn ?? null,
      notes: order.note?.[0]?.text ?? null,
    };
  }
}
