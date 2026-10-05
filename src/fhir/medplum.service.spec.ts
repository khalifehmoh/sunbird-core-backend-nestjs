import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { MedplumRegistry, type MedplumTenant } from './medplum-registry';
import { MedplumService, ON_BEHALF_OF_HEADER } from './medplum.service';

const TENANT: MedplumTenant = {
  tenantCode: 'T1',
  projectId: 'project-1',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  organizationId: 'org-root',
  branches: {},
  members: {
    'user-1': { membershipId: 'membership-1', practitionerId: 'pract-1' },
    system: { membershipId: 'membership-sys', practitionerId: 'pract-sys' },
  },
};

function buildService(enabled = true) {
  const config = {
    get: (key: string) =>
      ({
        'medplum.enabled': enabled,
        'medplum.baseUrl': 'http://medplum.test/',
      })[key],
  } as unknown as ConfigService;
  const registry = {
    tenant: (id: string) => (id === 'tenant-1' ? TENANT : undefined),
  } as unknown as MedplumRegistry;
  return new MedplumService(config, registry);
}

describe('MedplumService', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/oauth2/token')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }),
            ),
          );
        }
        return Promise.resolve(
          new Response('{"resourceType":"Patient","id":"p1"}', {
            headers: { 'content-type': 'application/fhir+json' },
          }),
        );
      });
  });

  afterEach(() => jest.restoreAllMocks());

  const fhirCalls = () =>
    fetchMock.mock.calls.filter(
      ([url]) => !String(url).endsWith('/oauth2/token'),
    );

  it('refuses to send anything when the tenant is not provisioned', async () => {
    const service = buildService();
    await expect(
      service.request(
        { tenantId: 'unknown', userId: 'user-1' },
        { method: 'GET', path: 'Patient' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a user who has no membership instead of falling back to the client', async () => {
    const service = buildService();
    await expect(
      service.request(
        { tenantId: 'tenant-1', userId: 'someone-else' },
        { method: 'GET', path: 'Patient' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(() =>
      service.getClient({ tenantId: 'tenant-1', userId: 'someone-else' }),
    ).toThrow(ForbiddenException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is unavailable when the integration is switched off', () => {
    expect(() =>
      buildService(false).getClient({ tenantId: 'tenant-1', userId: 'user-1' }),
    ).toThrow(ServiceUnavailableException);
  });

  it('delegates every request to the actor membership', async () => {
    const service = buildService();
    const response = await service.request(
      { tenantId: 'tenant-1', userId: 'user-1' },
      { method: 'GET', path: 'Patient/p1' },
    );

    expect(response.status).toBe(200);
    const [url, init] = fhirCalls()[0] as [string, RequestInit];
    expect(url).toBe('http://medplum.test/fhir/R4/Patient/p1');
    const headers = new Headers(init.headers);
    expect(headers.get(ON_BEHALF_OF_HEADER)).toBe(
      'ProjectMembership/membership-1',
    );
    expect(headers.get('Authorization')).toBe('Bearer tok-1');
  });

  it('delegates typed-client calls too, and system work to the system member', async () => {
    const service = buildService();
    await service
      .getClient({ tenantId: 'tenant-1', userId: 'system' })
      .readResource('Patient', 'p1');

    const [, init] = fhirCalls()[0] as [string, RequestInit];
    expect(new Headers(init.headers).get(ON_BEHALF_OF_HEADER)).toBe(
      'ProjectMembership/membership-sys',
    );
  });

  it('logs in once per tenant and reuses the token', async () => {
    const service = buildService();
    const actor = { tenantId: 'tenant-1', userId: 'user-1' };
    await Promise.all([
      service.request(actor, { method: 'GET', path: 'Patient' }),
      service.request(actor, { method: 'GET', path: 'Encounter' }),
    ]);
    await service.request(actor, { method: 'GET', path: 'Location' });

    const logins = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/oauth2/token'),
    );
    expect(logins).toHaveLength(1);
    expect(fhirCalls()).toHaveLength(3);
  });

  it('logs in again once when Medplum rejects the cached token', async () => {
    const service = buildService();
    const actor = { tenantId: 'tenant-1', userId: 'user-1' };
    let rejected = false;
    fetchMock.mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/oauth2/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: 'tok', expires_in: 3600 }),
          ),
        );
      }
      if (!rejected) {
        rejected = true;
        return Promise.resolve(new Response('{}', { status: 401 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const response = await service.request(actor, {
      method: 'GET',
      path: 'Patient',
    });
    expect(response.status).toBe(200);
  });
});
