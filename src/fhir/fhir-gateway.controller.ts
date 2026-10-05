import {
  All,
  Controller,
  ForbiddenException,
  HttpException,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import { ApiCookieAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { OperationOutcome } from '@medplum/fhirtypes';
import { assertPermissions } from '../auth/permissions';
import { User } from '../database/entities/user.entity';
import {
  ALLOWED_OPERATIONS,
  FHIR_JSON_CONTENT_TYPE,
  PATIENT_MGMT_PERMISSIONS,
  READONLY_RESOURCE_TYPES,
  WRITABLE_RESOURCE_TYPES,
} from './fhir.constants';
import { actorOf, type MedplumActor } from './medplum-actor';
import { MedplumService } from './medplum.service';
import { collectReferences } from './references';

type AuthenticatedRequest = Request & { user: User };

const READ_METHODS = new Set(['GET', 'HEAD']);
const MAX_REFERENCES_PER_WRITE = 50;

/**
 * The only FHIR surface this platform exposes.
 *
 * `@medplum/react` talks FHIR, not a bespoke REST dialect, so the components
 * are pointed at this path instead of at Medplum. Everything still goes through
 * the existing cookie-JWT guard, and Medplum's URL never reaches the browser.
 *
 * Tenant and branch isolation is not decided here. Every request is delegated
 * to the caller's own Medplum `ProjectMembership`, so Medplum applies that
 * member's access policy to the request itself, whatever shape it takes:
 * searches, conditional writes, `_include`, `$graphql`, `$everything`. What the
 * gateway still owns is the surface (an allow-list of resource types and
 * operations), the Sunbird permission codes, and the one thing Medplum does not
 * check, that the targets of a write's references are visible to the caller.
 * Errors are returned as `OperationOutcome` so callers stay on the FHIR
 * contract rather than this API's own error shape.
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
    try {
      await this.handle(pathParam, req, res);
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.sendOutcome(
        res,
        error.getStatus(),
        this.issueCodeFor(error.getStatus()),
        error.message,
      );
    }
  }

  private async handle(
    pathParam: string | string[],
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> {
    const segments = (
      Array.isArray(pathParam) ? pathParam : [pathParam]
    ).filter(Boolean);
    const actor = actorOf(req.user);

    const [head] = segments;
    const isOperation = head?.startsWith('$') || head === 'metadata';
    const isWrite = !READ_METHODS.has(req.method);
    const path = segments.join('/');

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
      if (head === '$graphql') {
        assertPermissions(req.user, PATIENT_MGMT_PERMISSIONS.read);
        if (this.isGraphqlMutation(req.body)) {
          throw new ForbiddenException('GraphQL mutations are not exposed');
        }
      }
      await this.forward(actor, req, res, path, req.body);
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

    assertPermissions(req.user, this.permissionFor(req.method, segments));

    if (isWrite && req.body && typeof req.body === 'object') {
      const rejection = await this.unreachableReference(actor, req.body);
      if (rejection) {
        this.sendOutcome(res, 400, 'invalid', rejection);
        return;
      }
    }
    await this.forward(actor, req, res, path, req.body);
  }

  /** Sunbird permission code a FHIR interaction needs. */
  private permissionFor(method: string, segments: string[]): string {
    const isSearchPost = method === 'POST' && segments.at(-1) === '_search';
    if (READ_METHODS.has(method) || isSearchPost) {
      return PATIENT_MGMT_PERMISSIONS.read;
    }
    if (method === 'POST') {
      // `POST Patient` creates; `POST Patient/1/$op` changes an instance.
      return segments.length > 1
        ? PATIENT_MGMT_PERMISSIONS.update
        : PATIENT_MGMT_PERMISSIONS.create;
    }
    if (method === 'DELETE') {
      return PATIENT_MGMT_PERMISSIONS.delete;
    }
    return PATIENT_MGMT_PERMISSIONS.update;
  }

  /**
   * Resolves every reference in a write body as the caller. Returns a message
   * when one cannot be seen by them, which includes references into another
   * branch or tenant, because Medplum answers 404 for those.
   */
  private async unreachableReference(
    actor: MedplumActor,
    body: unknown,
  ): Promise<string | undefined> {
    const { local, unverifiable } = collectReferences(body);
    if (unverifiable.length > 0) {
      return `Reference ${unverifiable[0]} cannot be verified; use a relative Type/id reference`;
    }
    if (local.length > MAX_REFERENCES_PER_WRITE) {
      return `A write may reference at most ${MAX_REFERENCES_PER_WRITE} resources`;
    }
    const checks = await Promise.all(
      local.map(async (reference) => {
        const { status } = await this.medplum.request(actor, {
          method: 'GET',
          path: reference,
        });
        return status === 200 ? undefined : reference;
      }),
    );
    const missing = checks.find((reference) => reference !== undefined);
    return missing ? `Reference ${missing} not found` : undefined;
  }

  private isGraphqlMutation(body: unknown): boolean {
    const query = (body as { query?: unknown } | undefined)?.query;
    return typeof query === 'string' && /\bmutation\b/i.test(query);
  }

  private async forward(
    actor: MedplumActor,
    req: AuthenticatedRequest,
    res: Response,
    path: string,
    body: unknown,
  ): Promise<void> {
    const hasBody = body !== undefined && body !== null && req.method !== 'GET';
    const response = await this.medplum.request(actor, {
      method: req.method,
      path,
      search: req.url.split('?')[1],
      body: hasBody ? JSON.stringify(body) : undefined,
      contentType: req.headers['content-type'],
    });
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

  private issueCodeFor(
    status: number,
  ): OperationOutcome['issue'][number]['code'] {
    if (status === 403) return 'forbidden';
    if (status === 401) return 'login';
    if (status === 503) return 'transient';
    if (status === 400) return 'invalid';
    return 'exception';
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
