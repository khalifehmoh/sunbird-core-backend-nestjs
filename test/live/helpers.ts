import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationError } from 'class-validator';
import cookieParser from 'cookie-parser';
import { json, text } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';

/**
 * Live e2e: boots the real AppModule against the Postgres and Medplum from
 * `.env`. Nothing here deletes data. Everything the tests create carries
 * `runTag` in a name or note so it can be found in Medplum afterwards.
 *
 * Needs: the docker stack (`npm run medplum:up`), `MEDPLUM_ENABLED=true`,
 * `INTEGRATION_API_KEY`, and a platform admin login, taken from
 * `E2E_USERNAME` / `E2E_PASSWORD` or the local `LOCAL_CREDENTIALS.md`.
 */
export const liveEnabled = process.env.MEDPLUM_ENABLED === 'true';

/** `describe` that skips, with a visible reason, when the stack is not configured. */
export const describeLive: jest.Describe = liveEnabled
  ? describe
  : (((name: string, fn: () => void) => {
      describe.skip(`${name} (set MEDPLUM_ENABLED=true to run)`, fn);
    }) as unknown as jest.Describe);

function credentials(): { username: string; password: string } {
  const username = process.env.E2E_USERNAME;
  const password = process.env.E2E_PASSWORD;
  if (username && password) return { username, password };

  const file = join(process.cwd(), 'LOCAL_CREDENTIALS.md');
  if (existsSync(file)) {
    const body = readFileSync(file, 'utf8');
    const user = /Username:\s*`([^`]+)`/.exec(body)?.[1];
    const pass = /Password:\s*`([^`]+)`/.exec(body)?.[1];
    if (user && pass) return { username: user, password: pass };
  }
  throw new Error(
    'Set E2E_USERNAME and E2E_PASSWORD (or provide LOCAL_CREDENTIALS.md).',
  );
}

export type Api = ReturnType<typeof request.agent>;

export type Live = {
  app: INestApplication<App>;
  /** Logged in as a platform admin. */
  admin: Api;
  tenantId: string;
  /** Unique per run, safe to put in names and notes. */
  runTag: string;
  /** A fresh, unauthenticated client. */
  anonymous: () => ReturnType<typeof request>;
  /** A new user in the same tenant with no permissions at all. */
  limitedUser: () => Promise<Api>;
  /** Posts an HL7 v2 message as the integration engine would. */
  hl7: (
    message: string,
    options?: { key?: string; tenantId?: string },
  ) => Promise<{
    status: number;
    ack: string;
    messageId?: string;
  }>;
};

export async function startLive(): Promise<Live> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>();

  // Same wiring as src/main.ts.
  app.use(cookieParser());
  app.use(
    json({
      type: [
        'application/json',
        'application/fhir+json',
        'application/json-patch+json',
      ],
      limit: '1mb',
    }),
  );
  app.use(
    text({
      type: ['text/plain', 'application/hl7-v2', 'x-application/hl7-v2+er7'],
      limit: '512kb',
    }),
  );
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: false,
      exceptionFactory: (errors: ValidationError[]) => ({
        validationErrors: Object.fromEntries(
          errors.map((error) => [
            error.property,
            Object.values(error.constraints ?? {})[0] ?? 'Invalid value',
          ]),
        ),
      }),
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();

  const server = app.getHttpServer();
  const admin = request.agent(server);
  const login = await admin.post('/api/v1/auth/login').send(credentials());
  if (login.status !== 200) {
    await app.close();
    throw new Error(`Admin login failed with ${login.status}`);
  }
  const tenantId = (login.body as { tenantId: string }).tenantId;
  const runTag = `E2E${Date.now().toString(36).toUpperCase()}`;

  return {
    app,
    admin,
    tenantId,
    runTag,
    anonymous: () => request(server),
    limitedUser: async () => {
      const username = `e2e-${runTag.toLowerCase()}-${Math.random().toString(36).slice(2, 6)}`;
      const agent = request.agent(server);
      const tenantCode = process.env.E2E_TENANT_CODE ?? 'AR-MED-001';
      await agent
        .post('/api/v1/auth/register')
        .send({
          username,
          email: `${username}@example.com`,
          password: 'password123',
          tenantCode,
        })
        .expect(201);
      return agent;
    },
    hl7: async (message, options = {}) => {
      const response = await request(server)
        .post('/api/v1/emr/integration/inbound')
        .set('content-type', 'text/plain')
        .set(
          'x-integration-key',
          options.key ?? process.env.INTEGRATION_API_KEY ?? '',
        )
        .set('x-tenant-id', options.tenantId ?? tenantId)
        .send(message);
      return {
        status: response.status,
        ack: typeof response.text === 'string' ? response.text : '',
        messageId: response.headers['x-message-id'],
      };
    },
  };
}

/** A national id that is unique per call: ten digits starting with 1. */
export function uniqueNationalId(): string {
  const tail = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9);
  return `1${tail}`;
}

/** A mobile number that is unique per call. */
export function uniqueMobile(): string {
  return `+9665${`${Date.now()}`.slice(-8)}`;
}

export type RegisteredPatient = {
  id: string;
  mrn: string;
  name: string;
};

export async function registerPatient(
  live: Live,
  overrides: Record<string, unknown> = {},
): Promise<RegisteredPatient & { mobile: string; nationalId: string }> {
  const mobile = uniqueMobile();
  const nationalId = uniqueNationalId();
  const response = await live.admin
    .post('/api/v1/emr/patients')
    .send({
      firstName: live.runTag,
      lastName: 'Patient',
      gender: 'female',
      birthDate: '1990-05-01',
      mobile,
      nationalId,
      preferredLanguage: 'en',
      ...overrides,
    })
    .expect(201);
  return { ...(response.body as RegisteredPatient), mobile, nationalId };
}

/** Free bed Location ids, in board order. */
export async function freeBeds(live: Live): Promise<string[]> {
  const response = await live.admin.get('/api/v1/adt/beds').expect(200);
  const locations = (
    response.body as {
      locations: {
        id: string;
        physicalType: string;
        occupiedByEncounterId: string | null;
        status: string | null;
      }[];
    }
  ).locations;
  return locations
    .filter(
      (location) =>
        location.physicalType === 'bd' &&
        !location.occupiedByEncounterId &&
        location.status !== 'inactive',
    )
    .map((location) => location.id);
}

/** Builds a pipe-delimited HL7 v2.5 message with `\r` segment separators. */
export function hl7Message(
  type: string,
  controlId: string,
  segments: string[],
): string {
  const header = `MSH|^~\\&|E2E|HOSP|EMR|HOSP|${hl7Timestamp()}||${type}|${controlId}|P|2.5`;
  return `${[header, ...segments].join('\r')}\r`;
}

export const pid = (mrn: string) =>
  `PID|1||${mrn}^^^HOSP^MR||Patient^Simulated||19800101|M`;

export function hl7Timestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** Polls until `read` returns something other than `undefined`. */
export async function eventually<T>(
  read: () => Promise<T | undefined>,
  { timeoutMs = 10000, intervalMs = 250 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

type ClinicDay = {
  date: string;
  working: boolean;
  slots: { start: string; status: string }[];
};

/** First free 30-minute slot for a provider, looking up to two weeks ahead. */
export async function nextFreeSlot(
  live: Live,
  practitionerId: string,
): Promise<{ start: string; date: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const days = (
    await live.admin
      .get('/api/v1/emr/appointments/slots')
      .query({ practitionerId, from: today, days: 14 })
      .expect(200)
  ).body as { days: ClinicDay[] };
  for (const day of days.days) {
    const slot = day.slots.find((s) => s.status === 'free');
    if (slot) return { start: slot.start, date: day.date };
  }
  throw new Error('No free clinic slot in the next two weeks');
}

/** Clinic-local HL7 wall-clock (`YYYYMMDDHHMMSS`) of a UTC ISO instant. */
export function hl7LocalOf(iso: string): string {
  const utc = Date.parse(iso);
  const local = new Date(utc + 180 * 60_000).toISOString();
  return local.replace(/[-:T]/g, '').slice(0, 14);
}
