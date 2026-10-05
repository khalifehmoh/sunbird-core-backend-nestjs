import { ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
import type { User } from '../database/entities/user.entity';
import { FhirGatewayController } from './fhir-gateway.controller';
import type { FhirRequest, MedplumService } from './medplum.service';

const READER = ['PATIENT_MGMT_READ'];
const WRITER = [
  'PATIENT_MGMT_READ',
  'PATIENT_MGMT_CREATE',
  'PATIENT_MGMT_UPDATE',
  'PATIENT_MGMT_DELETE',
];

function user(permissions: string[], tenantId: string | null = 'tenant-a') {
  return {
    userId: 'user-a1',
    role: 'STANDARD_USER',
    permissions,
    tenant: tenantId ? { tenantId } : null,
  } as unknown as User;
}

describe('FhirGatewayController', () => {
  let request: jest.Mock;
  let controller: FhirGatewayController;

  beforeEach(() => {
    request = jest.fn().mockResolvedValue({
      status: 200,
      contentType: 'application/fhir+json',
      body: '{"resourceType":"Bundle"}',
    });
    const medplum = {
      request,
      fhirBaseUrl: 'http://medplum.test/fhir/R4/',
    } as unknown as MedplumService;
    controller = new FhirGatewayController(medplum);
  });

  async function call(
    method: string,
    url: string,
    path: string[],
    options: {
      body?: unknown;
      permissions?: string[];
      tenant?: string | null;
    } = {},
  ) {
    const sent: { status?: number; body?: string } = {};
    const res = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      type() {
        return this;
      },
      send(payload: string) {
        sent.body = payload;
        return this;
      },
    } as unknown as Response;
    const req = {
      method,
      url,
      body: options.body,
      headers: { 'content-type': 'application/fhir+json' },
      protocol: 'http',
      get: () => 'localhost',
      user: user(options.permissions ?? WRITER, options.tenant),
    };
    await controller.proxy(path, req as never, res);
    return sent;
  }

  const forwarded = (): FhirRequest[] =>
    request.mock.calls.map((c) => c[1] as FhirRequest);

  it('delegates reads to the caller, not to a shared account', async () => {
    await call('GET', '/R4/Patient?name=ali', ['Patient']);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual({
      tenantId: 'tenant-a',
      userId: 'user-a1',
    });
    expect(forwarded()[0]).toMatchObject({
      method: 'GET',
      path: 'Patient',
      search: 'name=ali',
    });
  });

  it('passes the request shapes that used to bypass tenant scoping straight to Medplum', async () => {
    const patient = { resourceType: 'Patient', name: [{ family: 'X' }] };
    await call('PUT', '/R4/Patient?identifier=1054327890', ['Patient'], {
      body: patient,
    });
    await call('DELETE', '/R4/Patient?identifier=1054327890', ['Patient']);
    await call('POST', '/R4/$graphql', ['$graphql'], {
      body: { query: '{ PatientList { id } }' },
    });
    await call('GET', '/R4/Observation?_include=Observation:subject', [
      'Observation',
    ]);
    await call('GET', '/R4/Patient/123/$everything', [
      'Patient',
      '123',
      '$everything',
    ]);

    expect(forwarded().map((r) => `${r.method} ${r.path}`)).toEqual([
      'PUT Patient',
      'DELETE Patient',
      'POST $graphql',
      'GET Observation',
      'GET Patient/123/$everything',
    ]);
    // The body is forwarded as written: no tenant tag is injected any more.
    expect(JSON.parse(forwarded()[0].body ?? '{}')).toEqual(patient);
    request.mock.calls.forEach((c) =>
      expect(c[0]).toEqual({ tenantId: 'tenant-a', userId: 'user-a1' }),
    );
  });

  it('answers 403 as an OperationOutcome when the user has no tenant', async () => {
    const sent = await call('GET', '/R4/Patient', ['Patient'], {
      tenant: null,
    });
    expect(sent.status).toBe(403);
    expect(JSON.parse(sent.body ?? '{}').resourceType).toBe('OperationOutcome');
    expect(request).not.toHaveBeenCalled();
  });

  it('maps a missing Medplum membership to an OperationOutcome 403', async () => {
    request.mockRejectedValue(
      new ForbiddenException('User has no clinical data access'),
    );
    const sent = await call('GET', '/R4/Patient', ['Patient']);
    expect(sent.status).toBe(403);
    expect(JSON.parse(sent.body ?? '{}').issue[0].code).toBe('forbidden');
  });

  describe('permissions', () => {
    it.each([
      ['GET', ['Patient'], 'PATIENT_MGMT_READ'],
      ['POST', ['Patient'], 'PATIENT_MGMT_CREATE'],
      ['PUT', ['Patient', '1'], 'PATIENT_MGMT_UPDATE'],
      ['PATCH', ['Patient', '1'], 'PATIENT_MGMT_UPDATE'],
      ['DELETE', ['Patient', '1'], 'PATIENT_MGMT_DELETE'],
    ])('%s %j needs %s', async (method, path, code) => {
      const without = WRITER.filter((c) => c !== code);
      const denied = await call(method, '/R4/x', path, {
        body: { resourceType: 'Patient' },
        permissions: without,
      });
      expect(denied.status).toBe(403);
      expect(request).not.toHaveBeenCalled();

      const allowed = await call(method, '/R4/x', path, {
        body: { resourceType: 'Patient' },
        permissions: [code],
      });
      expect(allowed.status).toBe(200);
    });

    it('treats POST _search as a read', async () => {
      const sent = await call(
        'POST',
        '/R4/Patient/_search',
        ['Patient', '_search'],
        {
          permissions: READER,
          body: {},
        },
      );
      expect(sent.status).toBe(200);
    });

    it('denies a lab-only account everything, including terminology reads', async () => {
      const sent = await call('GET', '/R4/ValueSet', ['ValueSet'], {
        permissions: ['LABORATORY_READ'],
      });
      expect(sent.status).toBe(403);
    });

    it('requires the read code for $graphql and refuses mutations', async () => {
      expect(
        (
          await call('POST', '/R4/$graphql', ['$graphql'], {
            body: { query: '{ PatientList { id } }' },
            permissions: ['PATIENT_MGMT_CREATE'],
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('POST', '/R4/$graphql', ['$graphql'], {
            body: { query: 'mutation { PatientCreate(res: {}) { id } }' },
            permissions: READER,
          })
        ).status,
      ).toBe(403);
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('surface', () => {
    it('refuses resource types and operations that are not listed', async () => {
      expect((await call('GET', '/R4/Bot', ['Bot'])).status).toBe(404);
      expect((await call('POST', '/R4/$export', ['$export'])).status).toBe(404);
      expect(request).not.toHaveBeenCalled();
    });

    it('keeps terminology read-only', async () => {
      const sent = await call('POST', '/R4/ValueSet', ['ValueSet'], {
        body: { resourceType: 'ValueSet' },
      });
      expect(sent.status).toBe(403);
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('reference check on writes', () => {
    const encounter = {
      resourceType: 'Encounter',
      subject: { reference: 'Patient/other-branch' },
    };

    it('rejects a write that points at a resource the caller cannot read', async () => {
      request.mockResolvedValue({
        status: 404,
        contentType: 'application/fhir+json',
        body: '{}',
      });
      const sent = await call('POST', '/R4/Encounter', ['Encounter'], {
        body: encounter,
      });

      expect(sent.status).toBe(400);
      expect(sent.body).toContain('Patient/other-branch');
      expect(forwarded().map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET Patient/other-branch',
      ]);
    });

    it('forwards the write once every reference resolves for the caller', async () => {
      const sent = await call('POST', '/R4/Encounter', ['Encounter'], {
        body: encounter,
      });
      expect(sent.status).toBe(200);
      expect(forwarded().map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET Patient/other-branch',
        'POST Encounter',
      ]);
    });

    it('rejects references it cannot verify', async () => {
      const sent = await call('POST', '/R4/Encounter', ['Encounter'], {
        body: {
          resourceType: 'Encounter',
          subject: { reference: 'https://other.example/fhir/Patient/1' },
        },
      });
      expect(sent.status).toBe(400);
      expect(request).not.toHaveBeenCalled();
    });

    it('does not check references on reads', async () => {
      await call('GET', '/R4/Encounter?subject=Patient/x', ['Encounter']);
      expect(request).toHaveBeenCalledTimes(1);
    });
  });
});
