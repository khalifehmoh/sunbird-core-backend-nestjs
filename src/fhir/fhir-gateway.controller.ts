import { All, Controller, Param, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { OperationOutcome, Resource } from '@medplum/fhirtypes';
import { User } from '../database/entities/user.entity';
import {
  ALLOWED_OPERATIONS,
  FHIR_JSON_CONTENT_TYPE,
  READONLY_RESOURCE_TYPES,
  WRITABLE_RESOURCE_TYPES,
} from './fhir.constants';
import { MedplumService } from './medplum.service';
import {
  applyTenantTag,
  belongsToTenant,
  scopeSearchParams,
} from './tenant-scope';

type AuthenticatedRequest = Request & { user: User };

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * The only FHIR surface this platform exposes.
 *
 * `@medplum/react` talks FHIR, not a bespoke REST dialect, so the components
 * are pointed at this path instead of at Medplum. Everything still goes through
 * the existing cookie-JWT guard, and Medplum's URL never reaches the browser.
 *
 * This is a gate, not a pass-through: unlisted resource types are refused,
 * terminology is read-only, and clinical traffic is constrained to the caller's
 * tenant. Errors are returned as `OperationOutcome` so callers stay on the
 * FHIR contract rather than this API's own error shape.
 */
@ApiTags('fhir')
@ApiCookieAuth('cookieAuth')
@Controller('fhir')
export class FhirGatewayController {
  constructor(private readonly medplum: MedplumService) {}

  // Express 5 requires named wildcards, hence `*path` rather than `*`.
  @All('R4/*path')
  @ApiExcludeEndpoint()
  async proxy(
    @Param('path') pathParam: string | string[],
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const segments = (
      Array.isArray(pathParam) ? pathParam : [pathParam]
    ).filter(Boolean);
    const tenantId = req.user?.tenant?.tenantId;
    if (!tenantId) {
      this.sendOutcome(
        res,
        403,
        'forbidden',
        'User is not associated with a tenant',
      );
      return;
    }

    const [head, id] = segments;
    const isOperation = head?.startsWith('$') || head === 'metadata';
    const isWrite = !READ_METHODS.has(req.method);

    if (isOperation) {
      if (!ALLOWED_OPERATIONS.includes(head as never)) {
        this.sendOutcome(
          res,
          404,
          'not-supported',
          `Operation ${head} is not exposed`,
        );
        return;
      }
      await this.forward(req, res, segments.join('/'), req.body);
      return;
    }

    const writable = WRITABLE_RESOURCE_TYPES.includes(head as never);
    const readable =
      writable || READONLY_RESOURCE_TYPES.includes(head as never);
    if (!readable) {
      this.sendOutcome(
        res,
        404,
        'not-supported',
        `Resource type ${head} is not exposed`,
      );
      return;
    }
    if (isWrite && !writable) {
      this.sendOutcome(
        res,
        403,
        'forbidden',
        `Resource type ${head} is read-only`,
      );
      return;
    }

    // Terminology and conformance resources are shared, not tenant-owned.
    const tenantScoped = writable;
    const path = segments.join('/');

    if (isWrite && tenantScoped) {
      // Reject writes aimed at another tenant's resource before they happen;
      // a tag check on the response would be too late.
      if (id && !(await this.isVisible(head, id, tenantId))) {
        this.sendOutcome(res, 404, 'not-found', 'Resource not found');
        return;
      }
      const body: unknown =
        req.body && typeof req.body === 'object'
          ? applyTenantTag(req.body as Resource, tenantId)
          : req.body;
      await this.forward(req, res, path, body);
      return;
    }

    if (!tenantScoped) {
      await this.forward(req, res, path, req.body);
      return;
    }

    if (id && segments.length === 2) {
      // Plain instance read: forward, then drop the response if the resource
      // belongs to another tenant. 404 rather than 403, so the gateway does not
      // confirm that an out-of-scope id exists.
      const response = await this.forward(req, res, path, req.body, {
        defer: true,
      });
      const resource = this.parse(response.body);
      if (
        response.status === 200 &&
        resource &&
        !belongsToTenant(resource, tenantId)
      ) {
        this.sendOutcome(res, 404, 'not-found', 'Resource not found');
        return;
      }
      this.send(req, res, response);
      return;
    }

    if (id) {
      // Instance sub-paths (`_history`, `$everything`) answer with a Bundle,
      // which carries no tenant tag of its own — so authorize the instance
      // first and forward the response untouched.
      if (!(await this.isVisible(head, id, tenantId))) {
        this.sendOutcome(res, 404, 'not-found', 'Resource not found');
        return;
      }
      await this.forward(req, res, path, req.body);
      return;
    }

    // Search: force the tenant filter, discarding any caller-supplied `_tag`.
    const search = scopeSearchParams(
      new URLSearchParams(req.url.split('?')[1] ?? ''),
      tenantId,
    ).toString();
    await this.forward(req, res, path, req.body, { search });
  }

  private async isVisible(
    resourceType: string,
    id: string,
    tenantId: string,
  ): Promise<boolean> {
    const existing = await this.medplum.request({
      method: 'GET',
      path: `${resourceType}/${id}`,
    });
    if (existing.status !== 200) {
      return false;
    }
    const resource = this.parse(existing.body);
    return !!resource && belongsToTenant(resource, tenantId);
  }

  private async forward(
    req: AuthenticatedRequest,
    res: Response,
    path: string,
    body: unknown,
    options?: { search?: string; defer?: boolean },
  ): Promise<{ status: number; contentType: string; body: string }> {
    const hasBody = body !== undefined && body !== null && req.method !== 'GET';
    const response = await this.medplum.request({
      method: req.method,
      path,
      search: options?.search ?? req.url.split('?')[1],
      body: hasBody ? JSON.stringify(body) : undefined,
      contentType: req.headers['content-type'],
    });
    if (!options?.defer) {
      this.send(req, res, response);
    }
    return response;
  }

  private send(
    req: Request,
    res: Response,
    response: { status: number; contentType: string; body: string },
  ): void {
    res
      .status(response.status)
      .type(response.contentType)
      .send(this.rewriteUrls(req, response.body));
  }

  /**
   * Rewrites Medplum's own base URL in response bodies (Bundle paging links,
   * `Location` values) to this gateway's public path, so a client following a
   * link never ends up pointed at the internal service.
   */
  private rewriteUrls(req: Request, body: string): string {
    const internal = this.medplum.fhirBaseUrl;
    if (!body.includes(internal)) {
      return body;
    }
    const host = req.get('host') ?? 'localhost';
    const publicBase = `${req.protocol}://${host}/api/v1/fhir/R4/`;
    return body.replaceAll(internal, publicBase);
  }

  private parse(body: string): Resource | undefined {
    try {
      return JSON.parse(body) as Resource;
    } catch {
      return undefined;
    }
  }

  private sendOutcome(
    res: Response,
    status: number,
    code: OperationOutcome['issue'][number]['code'],
    message: string,
  ): void {
    const outcome: OperationOutcome = {
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code, details: { text: message } }],
    };
    res
      .status(status)
      .type(FHIR_JSON_CONTENT_TYPE)
      .send(JSON.stringify(outcome));
  }
}
