/**
 * Medplum checks that a write is allowed by the caller's access policy, but not
 * that the resources it points at are visible to the caller. A user scoped to
 * one branch could otherwise attach an `Encounter` to another branch's
 * `Patient`, which also pulls the encounter into that branch. The gateway
 * therefore reads every reference in a write body as the caller before
 * forwarding it.
 */

const LOCAL_REFERENCE = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/;

export type CollectedReferences = {
  /** Unique `Type/id` references that can be resolved on this server. */
  local: string[];
  /** References that cannot be checked: absolute URLs, versioned, odd shapes. */
  unverifiable: string[];
};

/**
 * Walks a JSON value and collects every `{ reference: "..." }`. Contained
 * (`#id`) and bundle-placeholder (`urn:`) references are skipped: neither
 * names a resource that exists outside the request.
 */
export function collectReferences(body: unknown): CollectedReferences {
  const local = new Set<string>();
  const unverifiable = new Set<string>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== 'object') return;

    for (const [key, child] of Object.entries(value)) {
      if (key === 'reference' && typeof child === 'string') {
        if (child.startsWith('#') || child.startsWith('urn:')) continue;
        if (LOCAL_REFERENCE.test(child)) {
          local.add(child);
        } else {
          unverifiable.add(child);
        }
      } else {
        visit(child);
      }
    }
  };
  visit(body);

  return { local: [...local], unverifiable: [...unverifiable] };
}
