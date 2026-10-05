import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MedplumClient } from '@medplum/core';
import { FHIR_JSON_CONTENT_TYPE } from './fhir.constants';

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

/**
 * Owns the single Medplum connection for this service.
 *
 * Medplum is reached with an OAuth2 client-credentials grant against a
 * project-scoped `ClientApplication` — one service account for the whole API,
 * not one Medplum identity per human. End users authenticate to Sunbird with
 * the existing JWT cookie and never see Medplum.
 */
@Injectable()
export class MedplumService {
  private readonly logger = new Logger(MedplumService.name);
  private readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private client: MedplumClient | undefined;
  private pendingLogin: Promise<MedplumClient> | undefined;

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>('medplum.enabled') ?? false;
    this.baseUrl = config.get<string>('medplum.baseUrl') ?? '';
    this.clientId = config.get<string>('medplum.clientId') ?? '';
    this.clientSecret = config.get<string>('medplum.clientSecret') ?? '';
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Medplum's internal FHIR base, used to strip it out of responses. */
  get fhirBaseUrl(): string {
    return new URL('fhir/R4/', this.baseUrl).toString();
  }

  /**
   * An authenticated client, logging in on first use and refreshing the access
   * token when it expires. Concurrent callers share a single login attempt.
   */
  async getClient(): Promise<MedplumClient> {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        'FHIR integration is disabled. Set MEDPLUM_ENABLED=true.',
      );
    }

    if (this.client) {
      await this.client.refreshIfExpired();
      return this.client;
    }

    this.pendingLogin ??= this.login();
    try {
      return await this.pendingLogin;
    } finally {
      // Cleared either way: on success `this.client` short-circuits the next
      // call, on failure the next call should retry rather than replay it.
      this.pendingLogin = undefined;
    }
  }

  /**
   * Forwards one FHIR interaction and returns the raw response.
   *
   * Deliberately not routed through `MedplumClient`'s typed helpers: those
   * throw on non-2xx and discard the `OperationOutcome` body, which is exactly
   * what a FHIR-conformant caller needs to see.
   */
  async request(request: FhirRequest): Promise<FhirResponse> {
    const client = await this.getClient();
    const url = new URL(`fhir/R4/${request.path}`, this.baseUrl);
    if (request.search) {
      url.search = request.search;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${client.getAccessToken()}`,
      Accept: FHIR_JSON_CONTENT_TYPE,
    };
    if (request.body !== undefined) {
      headers['Content-Type'] = request.contentType ?? FHIR_JSON_CONTENT_TYPE;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers,
        body: request.body,
      });
    } catch (error) {
      this.logger.error(
        `FHIR request failed: ${request.method} ${request.path}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException('FHIR backend is unreachable');
    }

    return {
      status: response.status,
      contentType:
        response.headers.get('content-type') ?? FHIR_JSON_CONTENT_TYPE,
      body: await response.text(),
    };
  }

  private async login(): Promise<MedplumClient> {
    const client = new MedplumClient({ baseUrl: this.baseUrl, fetch });
    try {
      await client.startClientLogin(this.clientId, this.clientSecret);
    } catch (error) {
      this.logger.error(
        `Medplum client login failed against ${this.baseUrl}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException('FHIR backend is unreachable');
    }
    this.logger.log(`Connected to Medplum at ${this.baseUrl}`);
    this.client = client;
    return client;
  }
}
