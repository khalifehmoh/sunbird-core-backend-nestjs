import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Communication, Encounter } from '@medplum/fhirtypes';
import { Job, Queue, Worker } from 'bullmq';
import {
  EVENT_NOTIFICATION_SYSTEM,
  EVENT_PATH_SYSTEM,
} from '../fhir/fhir.constants';
import { MedplumService } from '../fhir/medplum.service';
import { applyTenantTag, tenantTagSearchValue } from '../fhir/tenant-scope';
import {
  buildDischargeCommunication,
  buildDemoSms,
  CLINICAL_EVENTS_QUEUE,
  parseDemoSms,
  resolveDemoSmsPhone,
  type DemoSms,
  type DischargeNotificationJob,
} from './discharge-notification';

/**
 * BullMQ half of the event-driven spike.
 *
 * Medplum Subscriptions POST finished Encounters here; we enqueue a job on the
 * same Redis Medplum already uses, and the worker writes the discharge
 * Communication. The Bot half of the spike does the same write inside Medplum.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly enabled: boolean;
  private queue: Queue<DischargeNotificationJob> | undefined;
  private worker: Worker<DischargeNotificationJob> | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly medplum: MedplumService,
  ) {
    this.enabled = config.get<boolean>('events.enabled') ?? false;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Events spike disabled (EVENTS_ENABLED=false)');
      return;
    }

    const connection = {
      host: this.config.getOrThrow<string>('events.redis.host'),
      port: this.config.getOrThrow<number>('events.redis.port'),
      password: this.config.get<string>('events.redis.password'),
      maxRetriesPerRequest: null,
    };

    this.queue = new Queue(CLINICAL_EVENTS_QUEUE, { connection });
    this.worker = new Worker(
      CLINICAL_EVENTS_QUEUE,
      (job) => this.processDischarge(job),
      { connection, concurrency: 2 },
    );
    this.worker.on('completed', (job) => {
      this.logger.log(`BullMQ job ${job.id} completed (${job.name})`);
    });
    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `BullMQ job ${job?.id} failed: ${error.message}`,
        error.stack,
      );
    });
    this.logger.log(
      `BullMQ worker listening on ${connection.host}:${connection.port}/${CLINICAL_EVENTS_QUEUE}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  async enqueueFromEncounter(encounter: Encounter): Promise<{ jobId: string }> {
    if (!this.enabled || !this.queue) {
      throw new ServiceUnavailableException(
        'Events spike disabled. Set EVENTS_ENABLED=true.',
      );
    }
    if (encounter.resourceType !== 'Encounter' || !encounter.id) {
      throw new ServiceUnavailableException('Expected an Encounter resource');
    }
    if (encounter.status !== 'finished') {
      return { jobId: 'skipped-not-finished' };
    }

    const job = await this.queue.add(
      'discharge-notification',
      {
        encounterId: encounter.id,
        patientRef: encounter.subject?.reference,
        visitDisplay: encounter.identifier?.find((id) =>
          id.system?.includes('visit-number'),
        )?.value,
        tenantTag: encounter.meta?.tag?.find((t) =>
          t.system?.includes('tenant-id'),
        )?.code,
      },
      {
        jobId: `discharge-${encounter.id}-bullmq`,
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
    );
    return { jobId: String(job.id) };
  }

  async listNotifications(
    encounterId: string,
    tenantId: string,
  ): Promise<Communication[]> {
    // Communication has no standard `about` search param in Medplum; look up
    // the two deterministic identifiers the bot/BullMQ writers stamp.
    const client = await this.medplum.getClient();
    const tenantTag = tenantTagSearchValue(tenantId);
    const paths: Array<'bot' | 'bullmq'> = ['bot', 'bullmq'];
    const found: Communication[] = [];
    for (const path of paths) {
      const bundle = await client.search(
        'Communication',
        new URLSearchParams({
          _tag: tenantTag,
          identifier: `${EVENT_NOTIFICATION_SYSTEM}|discharge-${encounterId}-${path}`,
          _count: '1',
        }).toString(),
      );
      const resource = bundle.entry?.[0]?.resource as Communication | undefined;
      if (resource) found.push(resource);
    }
    return found;
  }

  summarizePaths(communications: Communication[]): {
    bot: boolean;
    bullmq: boolean;
    items: {
      path: string | undefined;
      id: string | undefined;
      sent: string | undefined;
    }[];
    sms?: DemoSms;
  } {
    const items = communications.map((c) => ({
      path: c.identifier?.find((id) => id.system === EVENT_PATH_SYSTEM)?.value,
      id: c.id,
      sent: c.sent,
    }));
    const bullmqComm = communications.find(
      (c) =>
        c.identifier?.find((id) => id.system === EVENT_PATH_SYSTEM)?.value ===
        'bullmq',
    );
    return {
      bot: items.some((i) => i.path === 'bot'),
      bullmq: items.some((i) => i.path === 'bullmq'),
      items,
      sms: bullmqComm ? parseDemoSms(bullmqComm) : undefined,
    };
  }

  /**
   * Server-side watch: poll Medplum until both paths exist or timeoutMs elapses.
   * Yields an initial empty "watching" snapshot so the UI can start pending,
   * then yields on each change, then a final complete/timeout snapshot.
   * Delays are intentional for the spike demo — real reactions are near-instant.
   */
  async *watchNotifications(
    encounterId: string,
    tenantId: string,
    timeoutMs = 15_000,
  ): AsyncGenerator<{
    encounterId: string;
    bot: boolean;
    bullmq: boolean;
    items: {
      path: string | undefined;
      id: string | undefined;
      sent: string | undefined;
    }[];
    sms?: DemoSms;
    status: 'watching' | 'complete' | 'timeout';
  }> {
    const pendingHoldMs = 1_500;
    const pathStaggerMs = 1_800;
    const pollMs = 500;

    const empty = {
      encounterId,
      bot: false,
      bullmq: false,
      items: [] as {
        path: string | undefined;
        id: string | undefined;
        sent: string | undefined;
      }[],
      sms: undefined as DemoSms | undefined,
      status: 'watching' as const,
    };
    // Always start pending so the UI can paint a waiting state before results.
    yield empty;
    await new Promise((resolve) => setTimeout(resolve, pendingHoldMs));

    const deadline = Date.now() + timeoutMs;
    let lastKey = 'false:false:';
    let emittedBot = false;
    let emittedBullmq = false;

    while (Date.now() < deadline) {
      const communications = await this.listNotifications(
        encounterId,
        tenantId,
      );
      const summary = this.summarizePaths(communications);
      const key = `${summary.bot}:${summary.bullmq}:${summary.items
        .map((i) => i.id)
        .join(',')}`;

      if (key !== lastKey) {
        lastKey = key;

        // Stagger same-tick arrivals so the UI shows Bot then BullMQ in action.
        if (summary.bot && !emittedBot) {
          emittedBot = true;
          yield {
            encounterId,
            bot: true,
            bullmq: emittedBullmq,
            items: summary.items.filter((i) => i.path === 'bot'),
            sms: undefined,
            status: 'watching',
          };
          await new Promise((resolve) => setTimeout(resolve, pathStaggerMs));
        }
        if (summary.bullmq && !emittedBullmq) {
          emittedBullmq = true;
          yield {
            encounterId,
            bot: emittedBot,
            bullmq: true,
            items: summary.items,
            sms: summary.sms,
            status: summary.bot ? 'complete' : 'watching',
          };
        } else if (summary.bot && summary.bullmq) {
          yield { encounterId, ...summary, status: 'complete' };
        } else {
          yield { encounterId, ...summary, status: 'watching' };
        }

        if (summary.bot && summary.bullmq) {
          return;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    const communications = await this.listNotifications(encounterId, tenantId);
    const summary = this.summarizePaths(communications);
    yield {
      encounterId,
      ...summary,
      status: summary.bot && summary.bullmq ? 'complete' : 'timeout',
    };
  }

  private async processDischarge(
    job: Job<DischargeNotificationJob>,
  ): Promise<void> {
    const client = await this.medplum.getClient();
    const encounter = await client.readResource(
      'Encounter',
      job.data.encounterId,
    );
    if (encounter.status !== 'finished') {
      this.logger.warn(
        `Skipping job ${job.id}: Encounter/${job.data.encounterId} is ${encounter.status}`,
      );
      return;
    }

    const existing = await client.search(
      'Communication',
      new URLSearchParams({
        identifier: `${EVENT_NOTIFICATION_SYSTEM}|discharge-${job.data.encounterId}-bullmq`,
        _count: '1',
      }).toString(),
    );
    if ((existing.entry?.length ?? 0) > 0) {
      this.logger.log(`Communication already exists for job ${job.id}`);
      return;
    }

    // Demo SMS sink — no paid gateway. Logs + FHIR Communication record only.
    let phone = resolveDemoSmsPhone();
    const patientId = encounter.subject?.reference?.replace(/^Patient\//, '');
    if (patientId) {
      try {
        const patient = await client.readResource('Patient', patientId);
        phone = resolveDemoSmsPhone(patient);
      } catch {
        this.logger.warn(
          `Demo SMS: could not read Patient/${patientId}; using fallback phone`,
        );
      }
    }
    const demoSms = buildDemoSms(encounter, phone);
    this.logger.log(
      `[demo-sms] provider=${demoSms.provider} to=${demoSms.to} body="${demoSms.body}"`,
    );

    const communication = buildDischargeCommunication(
      encounter,
      'bullmq',
      demoSms,
    );
    const tenantId = job.data.tenantTag;
    const created = await client.createResource(
      tenantId ? applyTenantTag(communication, tenantId) : communication,
    );
    this.logger.log(
      `BullMQ wrote Communication/${created.id} for Encounter/${encounter.id}`,
    );
  }
}
