import { randomUUID } from 'node:crypto';
import type {
  Bundle,
  BundleEntry,
  OperationOutcome,
  Resource,
} from '@medplum/fhirtypes';

/** `POST <ResourceType>` entry; Medplum assigns the id. */
export function createEntry(resource: Resource): BundleEntry {
  return {
    fullUrl: `urn:uuid:${randomUUID()}`,
    resource,
    request: { method: 'POST', url: resource.resourceType },
  };
}

/**
 * `PUT <ResourceType>/<id>` entry guarded by the version the caller read.
 *
 * `If-Match` makes Medplum reject the whole transaction when the resource has
 * changed since it was read, so a stale bed or encounter can never be
 * overwritten by a concurrent writer.
 */
export function updateEntry(resource: Resource): BundleEntry {
  if (!resource.id) {
    throw new Error(`Cannot update a ${resource.resourceType} without an id`);
  }
  const versionId = resource.meta?.versionId;
  return {
    resource,
    request: {
      method: 'PUT',
      url: `${resource.resourceType}/${resource.id}`,
      ...(versionId ? { ifMatch: `W/"${versionId}"` } : {}),
    },
  };
}

/** The resource Medplum returned for entry `index` of a transaction response. */
export function resultAt<T extends Resource>(
  bundle: Bundle,
  index: number,
): T | undefined {
  return bundle.entry?.[index]?.resource as T | undefined;
}

/**
 * True when a transaction failed because a guarded resource changed (or
 * already exists) rather than because the request itself was wrong.
 */
export function isConcurrentModification(error: unknown): boolean {
  const outcome = (error as { outcome?: OperationOutcome } | null)?.outcome;
  return outcome?.id === 'precondition-failed' || outcome?.id === 'conflict';
}
