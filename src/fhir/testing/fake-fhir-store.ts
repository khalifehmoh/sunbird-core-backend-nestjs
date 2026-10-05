import type {
  Bundle,
  BundleEntry,
  Encounter,
  OperationOutcome,
  Resource,
} from '@medplum/fhirtypes';
import type { MedplumActor } from '../medplum-actor';

type Stored = Resource & { id: string };

/** A rejected FHIR call, shaped like the `OperationOutcomeError` Medplum throws. */
function failure(id: string, text: string): Error {
  const outcome: OperationOutcome = {
    resourceType: 'OperationOutcome',
    id,
    issue: [{ severity: 'error', code: 'processing', details: { text } }],
  };
  return Object.assign(new Error(text), { outcome });
}

/**
 * In-memory stand-in for the slice of Medplum that `AdtService` uses, for
 * specs only.
 *
 * It models what the service depends on: per-resource versions, `If-Match`
 * on transaction entries, and all-or-nothing transactions (Medplum aborts the
 * whole bundle when any entry fails, see `fhir-router`'s batch processor).
 * Branch visibility is modelled as a set of hidden resources that every actor
 * except the tenant's `system` member gets a 404 for.
 *
 * `updateResource` is deliberately absent: an ADT action that tried to write
 * outside a transaction would throw and fail its spec.
 */
export class FakeFhirStore {
  private docs = new Map<string, Stored>();
  private nextId = 0;
  private clock = 0;
  private readonly hidden = new Set<string>();

  /** Every transaction bundle received, in order. */
  readonly transactions: Bundle[] = [];
  /** Standalone creates (`POST` outside a transaction). */
  readonly standaloneCreates: Resource[] = [];

  /** Runs once, just before the next transaction is evaluated. */
  beforeNextTransaction: (() => void) | undefined;

  seed<T extends Resource>(resource: T): T & { id: string } {
    const id = resource.id ?? `gen-${++this.nextId}`;
    const stored = this.stamp({ ...resource, id }, '1');
    this.docs.set(`${stored.resourceType}/${id}`, stored);
    return structuredClone(stored) as T & { id: string };
  }

  get<T extends Resource>(reference: string): T {
    const doc = this.docs.get(reference);
    if (!doc) throw new Error(`${reference} is not in the store`);
    return structuredClone(doc) as unknown as T;
  }

  all<T extends Resource>(resourceType: string): T[] {
    return [...this.docs.values()]
      .filter((doc) => doc.resourceType === resourceType)
      .map((doc) => structuredClone(doc) as unknown as T);
  }

  /** Simulates another writer committing a change to `reference`. */
  touch(reference: string): void {
    const doc = this.docs.get(reference);
    if (!doc) throw new Error(`${reference} is not in the store`);
    this.docs.set(
      reference,
      this.stamp(doc, String(Number(doc.meta?.versionId ?? '1') + 1)),
    );
  }

  /** Makes `reference` invisible to everyone but the `system` actor. */
  hide(reference: string): void {
    this.hidden.add(reference);
  }

  client(actor: MedplumActor) {
    const isSystem = actor.userId === 'system';
    const visible = (reference: string) =>
      isSystem || !this.hidden.has(reference);

    return {
      readResource: (resourceType: string, id: string): Promise<Resource> => {
        const reference = `${resourceType}/${id}`;
        const doc = this.docs.get(reference);
        if (!doc || !visible(reference)) {
          return Promise.reject(failure('not-found', `${reference} not found`));
        }
        return Promise.resolve(structuredClone(doc));
      },

      search: (resourceType: string, query: string): Promise<Bundle> =>
        Promise.resolve(this.search(resourceType, query, visible)),

      createResource: (resource: Resource): Promise<Resource> => {
        this.standaloneCreates.push(resource);
        const id = `gen-${++this.nextId}`;
        const stored = this.stamp({ ...structuredClone(resource), id }, '1');
        this.docs.set(`${stored.resourceType}/${id}`, stored);
        return Promise.resolve(structuredClone(stored));
      },

      executeBatch: (bundle: Bundle): Promise<Bundle> =>
        this.transaction(bundle),
    };
  }

  private transaction(bundle: Bundle): Promise<Bundle> {
    this.transactions.push(structuredClone(bundle));
    const hook = this.beforeNextTransaction;
    this.beforeNextTransaction = undefined;
    hook?.();

    // Stage every entry first and publish only if all of them succeed.
    const staged = new Map(this.docs);
    const entries: BundleEntry[] = [];
    for (const entry of bundle.entry ?? []) {
      const request = entry.request;
      if (!request || !entry.resource) {
        return Promise.reject(failure('bad-request', 'Malformed entry'));
      }

      if (request.method === 'POST') {
        const id = `gen-${++this.nextId}`;
        const stored = this.stamp(
          { ...structuredClone(entry.resource), id },
          '1',
        );
        const reference = `${stored.resourceType}/${id}`;
        staged.set(reference, stored);
        entries.push({
          resource: structuredClone(stored),
          response: { status: '201', location: reference },
        });
        continue;
      }

      const current = this.docs.get(request.url);
      if (!current) {
        return Promise.reject(failure('not-found', `${request.url} not found`));
      }
      if (
        request.ifMatch &&
        request.ifMatch !== `W/"${current.meta?.versionId}"`
      ) {
        return Promise.reject(
          failure('precondition-failed', 'Precondition failed'),
        );
      }
      const stored = this.stamp(
        { ...structuredClone(entry.resource), id: current.id },
        String(Number(current.meta?.versionId ?? '1') + 1),
      );
      staged.set(request.url, stored);
      entries.push({
        resource: structuredClone(stored),
        response: { status: '200', location: request.url },
      });
    }

    this.docs = staged;
    return Promise.resolve({
      resourceType: 'Bundle',
      type: 'transaction-response',
      entry: entries,
    });
  }

  private search(
    resourceType: string,
    query: string,
    visible: (reference: string) => boolean,
  ): Bundle {
    const params = new URLSearchParams(query);
    let matches = [...this.docs.values()].filter(
      (doc) =>
        doc.resourceType === resourceType &&
        visible(`${doc.resourceType}/${doc.id}`),
    );

    const status = params.get('status');
    if (status) {
      matches = matches.filter(
        (doc) => (doc as { status?: string }).status === status,
      );
    }

    const subject = params.get('subject');
    if (subject) {
      matches = matches.filter(
        (doc) => (doc as Encounter).subject?.reference === subject,
      );
    }

    const encounterClass = params.get('class');
    if (encounterClass) {
      matches = matches.filter(
        (doc) => (doc as Encounter).class?.code === encounterClass,
      );
    }

    const location = params.get('location');
    if (location) {
      matches = matches.filter((doc) =>
        (doc as Encounter).location?.some(
          (entry) => entry.location.reference === location,
        ),
      );
    }

    const identifier = params.get('identifier');
    if (identifier) {
      const [system, value] = identifier.split('|');
      matches = matches.filter((doc) =>
        (doc as Encounter).identifier?.some(
          (id) => id.system === system && (!value || id.value === value),
        ),
      );
    }

    if (params.get('_sort') === '-_lastUpdated') {
      matches.sort((a, b) =>
        (b.meta?.lastUpdated ?? '').localeCompare(a.meta?.lastUpdated ?? ''),
      );
    }

    const count = Number(params.get('_count') ?? matches.length);
    return {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: matches
        .slice(0, count)
        .map((doc) => ({ resource: structuredClone(doc) })),
    };
  }

  private stamp(resource: Stored, versionId: string): Stored {
    const lastUpdated = new Date(
      Date.UTC(2026, 0, 1, 0, 0, ++this.clock),
    ).toISOString();
    return { ...resource, meta: { ...resource.meta, versionId, lastUpdated } };
  }
}
