import type {
  Bundle,
  BundleEntry,
  OperationOutcome,
  Resource,
} from '@medplum/fhirtypes';
import type { MedplumActor } from '../medplum-actor';

type Stored = Resource & { id: string };
type Json = Record<string, unknown>;

/** A rejected FHIR call, shaped like the `OperationOutcomeError` Medplum throws. */
function failure(id: string, text: string): Error {
  const outcome: OperationOutcome = {
    resourceType: 'OperationOutcome',
    id,
    issue: [{ severity: 'error', code: 'processing', details: { text } }],
  };
  return Object.assign(new Error(text), { outcome });
}

/** Every value found by following `path` through objects and arrays. */
function valuesAt(value: unknown, path: readonly string[]): unknown[] {
  if (Array.isArray(value)) {
    return (value as unknown[]).flatMap((item) => valuesAt(item, path));
  }
  if (path.length === 0) return value === undefined ? [] : [value];
  if (value && typeof value === 'object') {
    return valuesAt((value as Json)[path[0]], path.slice(1));
  }
  return [];
}

function at(doc: Resource, ...paths: string[]): unknown[] {
  return paths.flatMap((path) => valuesAt(doc, path.split('.')));
}

/** Search parameters that are a plain equality on one or more element paths. */
const SIMPLE_PARAMS: Record<string, readonly string[]> = {
  _id: ['id'],
  status: ['status'],
  subject: ['subject.reference'],
  patient: [
    'subject.reference',
    'patient.reference',
    'participant.actor.reference',
  ],
  practitioner: ['participant.actor.reference'],
  encounter: ['encounter.reference'],
  class: ['class.code'],
  category: ['category.coding.code'],
  code: ['code.coding.code'],
  priority: ['priority'],
  interpretation: ['interpretation.coding.code'],
  result: ['result.reference'],
  location: ['location.location.reference', 'participant.actor.reference'],
  actor: ['participant.actor.reference'],
  'based-on': ['basedOn.reference'],
  partof: ['partOf.reference'],
  type: ['type.coding.code', 'serviceType.coding.code'],
  recipient: ['recipient.reference'],
  phone: ['telecom.value'],
  'clinical-status': ['clinicalStatus.coding.code'],
};

/** The date element each resource type's `date` parameter reads. */
const DATE_PATHS: Record<string, readonly string[]> = {
  Appointment: ['start'],
  Observation: ['effectiveDateTime', 'issued'],
  DiagnosticReport: ['issued', 'effectiveDateTime'],
  Encounter: ['period.start'],
  ServiceRequest: ['authoredOn'],
  Condition: ['recordedDate'],
  Communication: ['sent'],
  Slot: ['start'],
  Task: ['authoredOn'],
};

/** Every date-valued search parameter; each reads the type's `DATE_PATHS` element. */
const DATE_PARAMS = ['date', 'issued', 'recorded-date', 'authored', 'sent'];

/** `_include` parameters that are not simply an element name. */
const INCLUDE_PATHS: Record<string, string[]> = {
  actor: ['participant', 'actor', 'reference'],
};

function matchesToken(actual: unknown, wanted: string): boolean {
  const code = wanted.includes('|') ? wanted.split('|')[1] : wanted;
  return String(actual) === code;
}

function compareDate(actual: string, filter: string): boolean {
  const prefix = /^(eq|ne|gt|ge|lt|le)/.exec(filter)?.[1] ?? 'eq';
  const wanted = Date.parse(filter.replace(/^(eq|ne|gt|ge|lt|le)/, ''));
  const value = Date.parse(actual);
  if (Number.isNaN(value) || Number.isNaN(wanted)) return false;
  switch (prefix) {
    case 'gt':
      return value > wanted;
    case 'ge':
      return value >= wanted;
    case 'lt':
      return value < wanted;
    case 'le':
      return value <= wanted;
    case 'ne':
      return value !== wanted;
    default:
      return value === wanted;
  }
}

/**
 * In-memory stand-in for the slice of Medplum the EMR services use, for specs
 * only.
 *
 * It models what the services depend on: per-resource versions and history,
 * `If-Match` on transaction entries, conditional create (`ifNoneExist`),
 * `urn:uuid` reference resolution, and all-or-nothing transactions (Medplum
 * aborts the whole bundle when any entry fails). Branch visibility is
 * modelled as a set of hidden resources that every actor except the tenant's
 * `system` member gets a 404 for.
 *
 * Search understands the parameters the services use (see `SIMPLE_PARAMS`,
 * `date`, `identifier`, `name`, `_tag`, `_lastUpdated`, `_sort`, `_count`,
 * `_summary=count`, `_include`); anything else is ignored rather than guessed.
 *
 * `updateResource` is deliberately absent: a service that tried to write
 * outside a transaction would throw and fail its spec.
 */
export class FakeFhirStore {
  private docs = new Map<string, Stored>();
  private readonly versions = new Map<string, Stored[]>();
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
    this.put(`${stored.resourceType}/${id}`, stored);
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
    this.put(
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

      readHistory: (resourceType: string, id: string): Promise<Bundle> => {
        const reference = `${resourceType}/${id}`;
        const history = this.versions.get(reference);
        if (!history || !visible(reference)) {
          return Promise.reject(failure('not-found', `${reference} not found`));
        }
        return Promise.resolve({
          resourceType: 'Bundle',
          type: 'history',
          entry: [...history]
            .reverse()
            .map((doc) => ({ resource: structuredClone(doc) })),
        });
      },

      search: (resourceType: string, query: string): Promise<Bundle> =>
        Promise.resolve(this.search(resourceType, query, visible)),

      createResource: (resource: Resource): Promise<Resource> => {
        this.standaloneCreates.push(resource);
        const id = `gen-${++this.nextId}`;
        const stored = this.stamp({ ...structuredClone(resource), id }, '1');
        this.put(`${stored.resourceType}/${id}`, stored);
        return Promise.resolve(structuredClone(stored));
      },

      executeBatch: (bundle: Bundle): Promise<Bundle> =>
        this.transaction(bundle),
    };
  }

  private put(reference: string, stored: Stored): void {
    this.docs.set(reference, stored);
    this.versions.set(reference, [
      ...(this.versions.get(reference) ?? []),
      structuredClone(stored),
    ]);
  }

  private transaction(bundle: Bundle): Promise<Bundle> {
    this.transactions.push(structuredClone(bundle));
    const hook = this.beforeNextTransaction;
    this.beforeNextTransaction = undefined;
    hook?.();

    // Resolve `urn:uuid` placeholders to the ids the creates will receive.
    // Medplum rewrites them to `Type/id` references.
    const placeholders = new Map<string, string>();
    for (const entry of bundle.entry ?? []) {
      if (entry.request?.method === 'POST' && entry.fullUrl && entry.resource) {
        placeholders.set(
          entry.fullUrl,
          `${entry.resource.resourceType}/gen-${++this.nextId}`,
        );
      }
    }

    const resolve = <T>(value: T): T => {
      let json = JSON.stringify(value);
      for (const [fullUrl, reference] of placeholders) {
        json = json.split(`"${fullUrl}"`).join(`"${reference}"`);
      }
      return JSON.parse(json) as T;
    };

    // Stage every entry first and publish only if all of them succeed.
    const staged = new Map(this.docs);
    const written: [string, Stored][] = [];
    const entries: BundleEntry[] = [];
    for (const entry of bundle.entry ?? []) {
      const request = entry.request;
      if (!request || !entry.resource) {
        return Promise.reject(failure('bad-request', 'Malformed entry'));
      }

      if (request.method === 'POST') {
        if (request.ifNoneExist) {
          const existing = this.search(
            entry.resource.resourceType,
            request.ifNoneExist,
            () => true,
          ).entry?.[0]?.resource;
          if (existing) {
            const reference = `${existing.resourceType}/${existing.id}`;
            if (entry.fullUrl) placeholders.set(entry.fullUrl, reference);
            entries.push({
              resource: structuredClone(existing),
              response: { status: '200', location: reference },
            });
            continue;
          }
        }
        const id = entry.fullUrl
          ? placeholders.get(entry.fullUrl)!.split('/')[1]
          : `gen-${++this.nextId}`;
        const stored = this.stamp(
          { ...resolve(structuredClone(entry.resource)), id },
          '1',
        );
        const reference = `${stored.resourceType}/${id}`;
        staged.set(reference, stored);
        written.push([reference, stored]);
        entries.push({
          resource: structuredClone(stored),
          response: { status: '201', location: reference },
        });
        continue;
      }

      const current = staged.get(request.url) ?? this.docs.get(request.url);
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
        { ...resolve(structuredClone(entry.resource)), id: current.id },
        String(Number(current.meta?.versionId ?? '1') + 1),
      );
      staged.set(request.url, stored);
      written.push([request.url, stored]);
      entries.push({
        resource: structuredClone(stored),
        response: { status: '200', location: request.url },
      });
    }

    this.docs = staged;
    for (const [reference, stored] of written) {
      this.versions.set(reference, [
        ...(this.versions.get(reference) ?? []),
        structuredClone(stored),
      ]);
    }
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

    for (const [name, paths] of Object.entries(SIMPLE_PARAMS)) {
      for (const raw of params.getAll(name)) {
        const wanted = raw.split(',');
        matches = matches.filter((doc) =>
          at(doc, ...paths).some((actual) =>
            wanted.some((value) => matchesToken(actual, value)),
          ),
        );
      }
    }

    for (const raw of params.getAll('identifier')) {
      const wanted = raw.split(',');
      matches = matches.filter((doc) =>
        wanted.some((token) => {
          const [first, second] = token.split('|');
          const [system, value] =
            second === undefined ? [undefined, first] : [first, second];
          return (
            (doc as { identifier?: { system?: string; value?: string }[] })
              .identifier ?? []
          ).some(
            (id) =>
              (system === undefined || system === '' || id.system === system) &&
              (!value || id.value === value),
          );
        }),
      );
    }

    for (const raw of params.getAll('name')) {
      const needle = raw.toLowerCase();
      matches = matches.filter((doc) =>
        at(doc, 'name.text', 'name.family', 'name.given').some((part) =>
          String(part).toLowerCase().includes(needle),
        ),
      );
    }

    for (const raw of params.getAll('_tag')) {
      const wanted = raw.split(',');
      matches = matches.filter((doc) =>
        (doc.meta?.tag ?? []).some((tag) =>
          wanted.some((token) => {
            const [system, code] = token.includes('|')
              ? token.split('|')
              : [undefined, token];
            return (
              (system === undefined || tag.system === system) &&
              (!code || tag.code === code)
            );
          }),
        ),
      );
    }

    const datePaths = DATE_PATHS[resourceType] ?? [];
    const dateOf = (doc: Resource): string | undefined =>
      at(doc, ...datePaths)[0] as string | undefined;
    const dateFilters = DATE_PARAMS.flatMap((name) => params.getAll(name));
    for (const filter of dateFilters) {
      matches = matches.filter((doc) => {
        const value = dateOf(doc);
        return value !== undefined && compareDate(value, filter);
      });
    }
    for (const filter of params.getAll('_lastUpdated')) {
      matches = matches.filter((doc) =>
        compareDate(doc.meta?.lastUpdated ?? '', filter),
      );
    }

    const sort = params.get('_sort');
    if (sort) {
      const descending = sort.startsWith('-');
      const key = sort.replace(/^-/, '');
      const sortValue = (doc: Resource): string =>
        key === '_lastUpdated'
          ? (doc.meta?.lastUpdated ?? '')
          : DATE_PARAMS.includes(key)
            ? (dateOf(doc) ?? '')
            : '';
      matches.sort((a, b) =>
        descending
          ? sortValue(b).localeCompare(sortValue(a))
          : sortValue(a).localeCompare(sortValue(b)),
      );
    }

    if (params.get('_summary') === 'count') {
      return {
        resourceType: 'Bundle',
        type: 'searchset',
        total: matches.length,
      };
    }

    const count = Number(params.get('_count') ?? matches.length);
    const page = matches.slice(0, count);
    const entries: BundleEntry[] = page.map((doc) => ({
      resource: structuredClone(doc),
      search: { mode: 'match' },
    }));

    for (const include of params.getAll('_include')) {
      const [type, field] = include.split(':');
      if (type !== resourceType || !field) continue;
      const seen = new Set<string>();
      for (const doc of page) {
        for (const reference of valuesAt(
          doc,
          INCLUDE_PATHS[field] ?? [field, 'reference'],
        )) {
          const target = String(reference);
          if (seen.has(target) || !visible(target)) continue;
          seen.add(target);
          const included = this.docs.get(target);
          if (included) {
            entries.push({
              resource: structuredClone(included),
              search: { mode: 'include' },
            });
          }
        }
      }
    }

    return {
      resourceType: 'Bundle',
      type: 'searchset',
      total: matches.length,
      entry: entries,
    };
  }

  private stamp(resource: Stored, versionId: string): Stored {
    const lastUpdated = new Date(
      Date.UTC(2026, 0, 1, 0, 0, ++this.clock),
    ).toISOString();
    return { ...resource, meta: { ...resource.meta, versionId, lastUpdated } };
  }
}
