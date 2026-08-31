import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { ValidationError } from 'class-validator';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';

describe('Sunbird API (e2e)', () => {
  let app: INestApplication<App> | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let client: Client | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('sunbird_core_db')
      .withUsername('sunbird_app')
      .withPassword('sunbird_test_password')
      .start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query('CREATE SCHEMA core');
    for (const migration of [
      'V001__create_core_schema.sql',
      'V002__create_refresh_sessions_table.sql',
    ]) {
      await client.query(
        readFileSync(
          join(process.cwd(), 'db', 'migration', 'core', migration),
          'utf8',
        ),
      );
    }

    await client.query(
      `INSERT INTO core.tenants (tenant_code, tenant_name, organization_type)
       VALUES ('E2E-SYS', 'E2E System', 'HOSPITAL')`,
    );

    process.env.DB_HOST = container.getHost();
    process.env.DB_PORT = String(container.getPort());
    process.env.DB_NAME = container.getDatabase();
    process.env.DB_USERNAME = container.getUsername();
    process.env.DB_PASSWORD = container.getPassword();
    process.env.JWT_SECRET = 'e2e-test-secret-at-least-thirty-two-characters';
    process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
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
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await client?.end();
    await container?.stop();
  });

  it('runs registration, authentication, tenant CRUD and both list modes', async () => {
    if (!app) throw new Error('Application did not initialize');
    const agent = request.agent(app.getHttpServer());
    const registration = await agent
      .post('/api/v1/auth/register')
      .send({
        username: 'e2e-user',
        email: 'e2e@example.com',
        password: 'password123',
        tenantCode: 'E2E-SYS',
      })
      .expect(201);
    const registrationBody = registration.body as unknown as Record<
      string,
      unknown
    >;
    expect(registrationBody.accessToken).toBeUndefined();
    const setCookies = registration.headers[
      'set-cookie'
    ] as unknown as string[];
    expect(setCookies).toHaveLength(2);
    expect(setCookies.every((cookie) => cookie.includes('HttpOnly'))).toBe(
      true,
    );

    await agent
      .post('/api/v1/auth/login')
      .send({ username: 'e2e-user', password: 'password123' })
      .expect(200);

    await agent
      .get('/api/v1/auth/session')
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.objectContaining({
            username: 'e2e-user',
            requirePasswordChange: true,
          }),
        );
      });

    await request(app.getHttpServer()).get('/api/v1/tenants').expect(401);

    await agent.post('/api/v1/auth/refresh').expect(200);

    const created = await agent
      .post('/api/v1/tenants')
      .send({
        tenantCode: 'E2E',
        tenantName: 'E2E Tenant',
        organizationType: 'HOSPITAL',
        maxUsers: 50,
      })
      .expect(201);
    const createdBody = created.body as unknown as { tenantId: string };

    await agent.get(`/api/v1/tenants/${createdBody.tenantId}`).expect(200);

    await agent
      .put(`/api/v1/tenants/${createdBody.tenantId}`)
      .send({
        tenantCode: 'E2E',
        tenantName: 'Updated E2E Tenant',
        organizationType: 'HOSPITAL',
        maxUsers: 75,
      })
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.objectContaining({ tenantName: 'Updated E2E Tenant' }),
        );
      });

    await agent
      .get('/api/v1/tenants')
      .expect(200)
      .expect((response) => {
        expect(Array.isArray(response.body)).toBe(true);
      });

    await agent
      .get('/api/v1/tenants?page=0&search=E2E')
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          page: 0,
          size: 20,
          totalElements: 1,
          last: true,
        });
      });

    await agent.delete(`/api/v1/tenants/${createdBody.tenantId}`).expect(204);

    await agent
      .put('/api/v1/auth/change-password')
      .send({
        currentPassword: 'password123',
        newPassword: 'NewPassword2@',
      })
      .expect(200)
      .expect({
        message: 'Password changed successfully',
        requirePasswordChange: false,
      });
    await agent.get('/api/v1/auth/session').expect(401);

    await agent
      .post('/api/v1/auth/login')
      .send({
        username: 'e2e-user',
        password: 'NewPassword2@',
        rememberMe: true,
      })
      .expect(200)
      .expect((response) => {
        const body = response.body as unknown as {
          refreshTokenExpiresIn: number;
        };
        expect(body.refreshTokenExpiresIn).toBe(2592000000);
      });

    await agent.post('/api/v1/auth/logout').expect(204);
    await agent.get('/api/v1/tenants').expect(401);
  });
});
