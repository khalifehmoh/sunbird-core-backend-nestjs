import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MedplumClient } from '@medplum/core';
import { FHIR_JSON_CONTENT_TYPE } from './fhir.constants';
import type { MedplumActor } from './medplum-actor';
import { MedplumRegistry, type MedplumTenant } from './medplum-registry';

export type FhirRequest = {
  method: string;
  /** Path below `fhir/R4/`, e.g. `Patient/123`. */
  path: string;
  search?: string;
  body?: string;
  contentType?: string;
};

export type FhirResponse = {
  status: number;
  contentType: string;
  body: string;
};

export const ON_BEHALF_OF_HEADER = 'X-Medplum-On-Behalf-Of';

/** Refresh a cached access token this long before Medplum expires it. */
const TOKEN_EXPIRY_MARGIN_MS = 30_000;

type CachedToken = { value: string; expiresAt: number };

/**
 * The only place in this service that talks to Medplum.
 *
 * Each tenant is its own Medplum `Project`, with a Project Admin
 * `ClientApplication` that this API authenticates as. Calls are never made as
 * that client: Medplum builds the request's access policy from an
 * `X-Medplum-On-Behalf-Of: ProjectMembership/<id>` header, so every request is
 * delegated to the end user's membership (or the tenant's `system` member for
 * background work). A request that omitted the header would run with the
 * client's own Project Admin rights, so there is no code path here that can
 * send one: callers pass a {@link MedplumActor}, and an actor with no
 * provisioned membership is refused before anything leaves the process.
 */
@Injectable()
export class MedplumService {
  private readonly logger = new Logger(MedplumService.name);
  private readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly tokens = new Map<string, CachedToken>();
  private readonly pendingTokens = new Map<string, Promise<CachedToken>>();

  constructor(
    config: ConfigService,
    private readonly registry: MedplumRegistry,
  ) {
    this.enabled = config.get<boolean>('medplum.enabled') ?? false;
    this.baseUrl = config.get<string>('medplum.baseUrl') ?? '';
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Medplum's internal FHIR base, used to strip it out of responses. */
  get fhirBaseUrl(): string {
    return new URL('fhir/R4/', this.baseUrl).toString();
  }

  /**
   * A client whose every request is delegated to `actor`. It is built per call
   * and holds no credentials of its own: the access token and the delegation
   * header are applied by the fetch wrapper below.
   */
  getClient(actor: MedplumActor): MedplumClient {
    const target = this.resolve(actor);
    return new MedplumClient({
      baseUrl: this.baseUrl,
      cacheTime: 0,
      fetch: (url, init) =>
        this.send(target, String(url), init as RequestInit | undefined),
    });
  }

  /**
   * Forwards one FHIR interaction and returns the raw response.
   *
   * Deliberately not routed through `MedplumClient`'s typed helpers: those
   * throw on non-2xx and discard the `OperationOutcome` body, which is exactly
   * what a FHIR-conformant caller needs to see.
   */
  async request(
    actor: MedplumActor,
    request: FhirRequest,
  ): Promise<FhirResponse> {
    const target = this.resolve(actor);
    const url = new URL(`fhir/R4/${request.path}`, this.baseUrl);
    if (request.search) {
      url.search = request.search;
    }

    const headers: Record<string, string> = { Accept: FHIR_JSON_CONTENT_TYPE };
    if (request.body !== undefined) {
      headers['Content-Type'] = request.contentType ?? FHIR_JSON_CONTENT_TYPE;
    }

    const response = await this.send(target, url.toString(), {
      method: request.method,
      headers,
      body: request.body,
    });
    return {
      status: response.status,
      contentType:
        response.headers.get('content-type') ?? FHIR_JSON_CONTENT_TYPE,
      body: await response.text(),
    };
  }

  private resolve(actor: MedplumActor): DelegatedTarget {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        'FHIR integration is disabled. Set MEDPLUM_ENABLED=true.',
      );
    }
    const tenant = this.registry.tenant(actor.tenantId);
    if (!tenant) {
      throw new ForbiddenException('Tenant has no clinical data store');
    }
    const member = tenant.members[actor.userId];
    if (!member) {
      throw new ForbiddenException(
        'User has no clinical data access. Run npm run medplum:provision to sync memberships.',
      );
    }
    return {
      tenantId: actor.tenantId,
      tenant,
      membershipId: member.membershipId,
    };
  }

  /**
   * The single egress point. The delegation header is set unconditionally and
   * overrides anything a caller supplied, so no header that originated in a
   * browser request can change whose rights a call runs with.
   */
  private async send(
    target: DelegatedTarget,
    url: string,
    init: RequestInit | undefined,
    isRetry = false,
  ): Promise<Response> {
    const token = await this.accessToken(target);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set(
      ON_BEHALF_OF_HEADER,
      `ProjectMembership/${target.membershipId}`,
    );

    let response: Response;
    try {
      response = await fetch(url, { ...init, headers });
    } catch (error) {
      this.logger.error(
        `FHIR request failed: ${init?.method ?? 'GET'} ${url}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException('FHIR backend is unreachable');
    }

    if (response.status === 401 && !isRetry) {
      // Token revoked or the Medplum signing key rotated: log in again once.
      this.tokens.delete(target.tenantId);
      return this.send(target, url, init, true);
    }
    return response;
  }

  private async accessToken(target: DelegatedTarget): Promise<string> {
    const cached = this.tokens.get(target.tenantId);
    if (cached && cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
      return cached.value;
    }

    let pending = this.pendingTokens.get(target.tenantId);
    if (!pending) {
      pending = this.login(target.tenant);
      this.pendingTokens.set(target.tenantId, pending);
    }
    try {
      const token = await pending;
      this.tokens.set(target.tenantId, token);
      return token.value;
    } finally {
      this.pendingTokens.delete(target.tenantId);
    }
  }

  private async login(tenant: MedplumTenant): Promise<CachedToken> {
    try {
      const response = await fetch(new URL('oauth2/token', this.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: tenant.clientId,
          client_secret: tenant.clientSecret,
        }),
      });
      if (!response.ok) {
        throw new Error(`token endpoint answered ${response.status}`);
      }
      const json = (await response.json()) as {
        access_token: string;
        expires_in?: number;
      };
      return {
        value: json.access_token,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      };
    } catch (error) {
      this.logger.error(
        `Medplum client login failed for project ${tenant.projectId}: ${String(error)}`,
      );
      throw new ServiceUnavailableException('FHIR backend is unreachable');
    }
  }
}

type DelegatedTarget = {
  tenantId: string;
  tenant: MedplumTenant;
  membershipId: string;
};
