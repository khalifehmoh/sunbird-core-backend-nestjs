import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Registry key for the per-tenant automation identity used by background work. */
export const SYSTEM_MEMBER_ID = 'system';

export type MedplumMember = {
  membershipId: string;
  practitionerId: string;
  /** Branch the membership is scoped to; absent for tenant-wide members. */
  branchId?: string;
};

export type MedplumTenant = {
  tenantCode: string;
  projectId: string;
  clientId: string;
  clientSecret: string;
  /** Root `Organization` of the tenant. */
  organizationId: string;
  /** Sunbird branch id to the branch `Organization` id. */
  branches: Record<string, string>;
  /** Sunbird user id (or `system`) to that user's membership in the Project. */
  members: Record<string, MedplumMember>;
};

type RegistryFile = { tenants?: Record<string, MedplumTenant> };

/**
 * Where each Sunbird tenant lives in Medplum: its Project, the service client
 * the API authenticates with, and every user's ProjectMembership.
 *
 * Written by `scripts/medplum-setup.js`, read-only here. Spike storage: the
 * real module would keep ids on `core.tenants` / `core.branches` and the client
 * secrets in a secret store. The file is re-read when it changes so newly
 * provisioned tenants are picked up without restarting the API.
 */
@Injectable()
export class MedplumRegistry {
  private readonly logger = new Logger(MedplumRegistry.name);
  private readonly path: string;
  private loadedMtimeMs = -1;
  private tenants: Record<string, MedplumTenant> = {};

  constructor(config: ConfigService) {
    this.path = resolve(
      config.get<string>('medplum.tenantsFile') ?? '.medplum/tenants.json',
    );
  }

  tenant(tenantId: string): MedplumTenant | undefined {
    this.refresh();
    return this.tenants[tenantId];
  }

  tenantIdForProject(projectId: string): string | undefined {
    this.refresh();
    return Object.entries(this.tenants).find(
      ([, tenant]) => tenant.projectId === projectId,
    )?.[0];
  }

  allTenantIds(): string[] {
    this.refresh();
    return Object.keys(this.tenants);
  }

  /**
   * The `Organization` a member acts for: their branch, or the tenant root for
   * tenant-wide members.
   */
  organizationForMember(actor: {
    tenantId: string;
    userId: string;
  }): string | undefined {
    const tenant = this.tenant(actor.tenantId);
    if (!tenant) return undefined;
    const branchId = tenant.members[actor.userId]?.branchId;
    return (
      (branchId ? tenant.branches[branchId] : undefined) ??
      tenant.organizationId
    );
  }

  private refresh(): void {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      if (this.loadedMtimeMs !== -1) {
        this.logger.warn(`Medplum tenant registry ${this.path} disappeared`);
      }
      this.tenants = {};
      this.loadedMtimeMs = -1;
      return;
    }
    if (mtimeMs === this.loadedMtimeMs) return;

    try {
      const parsed = JSON.parse(
        readFileSync(this.path, 'utf8'),
      ) as RegistryFile;
      this.tenants = parsed.tenants ?? {};
      this.loadedMtimeMs = mtimeMs;
      this.logger.log(
        `Loaded Medplum registry: ${Object.keys(this.tenants).length} tenant(s)`,
      );
    } catch (error) {
      // Keep serving the last good copy rather than failing every request on
      // a half-written file.
      this.logger.error(
        `Could not read Medplum tenant registry ${this.path}: ${String(error)}`,
      );
    }
  }
}
