import type { Meta, Resource } from '@medplum/fhirtypes';
import { TENANT_TAG_SYSTEM } from './fhir.constants';

/**
 * Tenant scoping for FHIR resources, expressed as pure functions so the rules
 * stay testable without a running Medplum.
 *
 * This is deliberately application-level enforcement: one Medplum service
 * account is shared by the whole API, and NestJS decides what each caller may
 * see. Pushing this down into a Medplum `AccessPolicy` per tenant is the
 * production answer (see the auth-seam spike) and would also cover the
 * `$graphql` hole noted on the gateway.
 */

/** Returns the tenant tag on a resource, or undefined if it carries none. */
export function readTenantTag(resource: Resource): string | undefined {
  return resource.meta?.tag?.find((tag) => tag.system === TENANT_TAG_SYSTEM)
    ?.code;
}

/** Adds (or replaces) the tenant tag, leaving the rest of `meta` untouched. */
export function applyTenantTag<T extends Resource>(
  resource: T,
  tenantId: string,
): T {
  const otherTags = (resource.meta?.tag ?? []).filter(
    (tag) => tag.system !== TENANT_TAG_SYSTEM,
  );
  const meta: Meta = {
    ...resource.meta,
    tag: [...otherTags, { system: TENANT_TAG_SYSTEM, code: tenantId }],
  };
  return { ...resource, meta };
}

/** The `_tag` search parameter value that selects a single tenant. */
export function tenantTagSearchValue(tenantId: string): string {
  return `${TENANT_TAG_SYSTEM}|${tenantId}`;
}

/**
 * Constrains a FHIR search to one tenant. Any caller-supplied `_tag` is
 * dropped rather than merged, so a crafted query cannot widen its own scope.
 */
export function scopeSearchParams(
  params: URLSearchParams,
  tenantId: string,
): URLSearchParams {
  const scoped = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (key !== '_tag') {
      scoped.append(key, value);
    }
  }
  scoped.append('_tag', tenantTagSearchValue(tenantId));
  return scoped;
}

/** True when a resource is visible to the given tenant. */
export function belongsToTenant(resource: Resource, tenantId: string): boolean {
  return readTenantTag(resource) === tenantId;
}
