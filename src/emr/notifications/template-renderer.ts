const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** The distinct `{{names}}` a template uses, in order of first appearance. */
export function placeholdersOf(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER)) {
    found.add(match[1].toLowerCase());
  }
  return [...found];
}

/**
 * Fills `{{placeholders}}`. A placeholder with no value renders as an empty
 * string and is reported in `missing`, so the caller can decide whether a
 * half-filled message should go out.
 */
export function renderTemplate(
  body: string,
  values: Readonly<Record<string, string | undefined | null>>,
): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = body.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name.toLowerCase()];
    if (value === undefined || value === null || value === '') {
      missing.add(name.toLowerCase());
      return '';
    }
    return value;
  });
  return { text: text.trim(), missing: [...missing] };
}
