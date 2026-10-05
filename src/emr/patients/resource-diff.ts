export type FieldChange = {
  /** JSON path, e.g. `telecom[0].value`. */
  path: string;
  before: string | null;
  after: string | null;
};

/** Server-maintained fields that change on every version and say nothing clinical. */
const IGNORED_TOP_LEVEL = new Set(['meta', 'id', 'resourceType', 'text']);

const MAX_VALUE_LENGTH = 200;

function flatten(
  value: unknown,
  path: string,
  into: Map<string, string>,
): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, into));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (path === '' && IGNORED_TOP_LEVEL.has(key)) continue;
      flatten(child, path === '' ? key : `${path}.${key}`, into);
    }
    return;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  into.set(
    path,
    text.length > MAX_VALUE_LENGTH
      ? `${text.slice(0, MAX_VALUE_LENGTH)}…`
      : text,
  );
}

function flat(resource: unknown): Map<string, string> {
  const into = new Map<string, string>();
  flatten(resource, '', into);
  return into;
}

/**
 * Field-level difference between two versions of a FHIR resource, the way the
 * blueprint's change log shows it. `before` undefined means the resource was
 * just created, so every field is reported as added.
 */
export function diffResources(before: unknown, after: unknown): FieldChange[] {
  const previous =
    before === undefined ? new Map<string, string>() : flat(before);
  const current = flat(after);
  const paths = [...new Set([...previous.keys(), ...current.keys()])].sort();

  const changes: FieldChange[] = [];
  for (const path of paths) {
    const was = previous.get(path) ?? null;
    const now = current.get(path) ?? null;
    if (was !== now) changes.push({ path, before: was, after: now });
  }
  return changes;
}
