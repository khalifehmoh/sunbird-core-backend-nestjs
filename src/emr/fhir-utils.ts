import type {
  Bundle,
  Coding,
  HumanName,
  Patient,
  Reference,
  Resource,
} from '@medplum/fhirtypes';
import type { MedplumClient } from '@medplum/core';
import { LANGUAGE_EXTENSION_URL, MRN_SYSTEM } from '../fhir/fhir.constants';
import {
  ENTRY_SOURCE_SYSTEM,
  ENTRY_SOURCES,
  type EntrySource,
} from './emr.constants';

/** A parameter repeated once per value, which FHIR reads as AND. */
export type RepeatedParam = { all: readonly string[] };

export type SearchParams = Record<
  string,
  | string
  | number
  | boolean
  | readonly (string | number)[]
  | RepeatedParam
  | undefined
>;

/**
 * Builds a FHIR query string. An array becomes comma-separated OR values;
 * `{ all: [...] }` repeats the parameter (AND), as in `date=ge…&date=lt…`.
 */
export function query(params: SearchParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (typeof value === 'object' && 'all' in value) {
      for (const item of value.all) search.append(key, item);
    } else if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  return search.toString();
}

/** `date=ge<from>&date=lt<to>`; either bound may be omitted. */
export function dateRange(
  from?: string,
  to?: string,
): RepeatedParam | undefined {
  const all = [...(from ? [`ge${from}`] : []), ...(to ? [`lt${to}`] : [])];
  return all.length > 0 ? { all } : undefined;
}

export async function searchBundle(
  client: MedplumClient,
  resourceType: string,
  params: SearchParams,
): Promise<Bundle> {
  return client.search(resourceType as 'Patient', query(params));
}

export function resourcesOf<T extends Resource>(
  bundle: Bundle,
  resourceType?: string,
): T[] {
  return (bundle.entry ?? []).flatMap((entry) =>
    entry.resource &&
    (!resourceType || entry.resource.resourceType === resourceType)
      ? [entry.resource as T]
      : [],
  );
}

/** Resources of one type in a bundle, by id (for `_include` lookups). */
export function indexById<T extends Resource>(
  bundle: Bundle,
  resourceType: string,
): Map<string, T> {
  return new Map(
    resourcesOf<T>(bundle, resourceType).flatMap((resource) =>
      resource.id ? [[resource.id, resource] as const] : [],
    ),
  );
}

/** Number of matches for a search, using the server's count, not a page. */
export async function countOf(
  client: MedplumClient,
  resourceType: string,
  params: SearchParams,
): Promise<number> {
  const bundle = await searchBundle(client, resourceType, {
    ...params,
    _summary: 'count',
    _total: 'accurate',
  });
  return bundle.total ?? 0;
}

/** `Patient/123` or `Patient/123/_history/2` to `123`. */
export function idOfReference(
  reference: string | undefined,
  resourceType?: string,
): string | undefined {
  if (!reference) return undefined;
  const match = /^([A-Za-z]+)\/([^/]+)/.exec(reference);
  if (!match) return undefined;
  if (resourceType && match[1] !== resourceType) return undefined;
  return match[2];
}

export function referenceTo<T extends Resource>(
  resourceType: T['resourceType'],
  id: string,
  display?: string,
): Reference<T> {
  return {
    reference: `${resourceType}/${id}`,
    ...(display ? { display } : {}),
  };
}

export function codingTag(system: string, code: string): Coding {
  return { system, code };
}

export function hasTag(
  resource: Resource,
  system: string,
  code?: string,
): boolean {
  return (resource.meta?.tag ?? []).some(
    (tag) => tag.system === system && (code === undefined || tag.code === code),
  );
}

export function entrySourceOf(resource: Resource): EntrySource {
  const code = resource.meta?.tag?.find(
    (tag) => tag.system === ENTRY_SOURCE_SYSTEM,
  )?.code;
  return ENTRY_SOURCES.includes(code as EntrySource)
    ? (code as EntrySource)
    : 'MANUAL';
}

/** The `meta.tag` list with every tag of `system` replaced by `code`. */
export function withTag(
  resource: Resource,
  system: string,
  code: string,
): Coding[] {
  return [
    ...(resource.meta?.tag ?? []).filter((tag) => tag.system !== system),
    codingTag(system, code),
  ];
}

function isArabic(name: HumanName): boolean {
  return (name.extension ?? []).some(
    (extension) =>
      extension.url === LANGUAGE_EXTENSION_URL &&
      extension.valueCode?.toLowerCase().startsWith('ar'),
  );
}

function nameText(name: HumanName | undefined): string | undefined {
  if (!name) return undefined;
  const text =
    name.text ??
    [...(name.given ?? []), name.family].filter(Boolean).join(' ').trim();
  return text || undefined;
}

/** Display names for a patient: the primary (English) name and the Arabic one. */
export function patientNames(patient: Patient | undefined): {
  name: string;
  nameAr: string | null;
} {
  const names = patient?.name ?? [];
  const arabic = names.find(isArabic);
  const primary = names.find((name) => !isArabic(name)) ?? names[0];
  return {
    name: nameText(primary) ?? (patient?.id ? `Patient/${patient.id}` : ''),
    nameAr: nameText(arabic) ?? null,
  };
}

export function mrnOf(patient: Patient | undefined): string | null {
  return (
    patient?.identifier?.find((id) => id.system === MRN_SYSTEM)?.value ?? null
  );
}

export function mobileOf(patient: Patient | undefined): string | null {
  return (
    patient?.telecom?.find((point) => point.system === 'phone')?.value ?? null
  );
}

/** UTC bounds of a local calendar day (`YYYY-MM-DD`) at a fixed UTC offset. */
export function localDayRange(
  date: string,
  utcOffsetMinutes: number,
): { start: string; end: string } {
  const [year, month, day] = date.split('-').map(Number);
  const startMs =
    Date.UTC(year, month - 1, day, 0, 0, 0) - utcOffsetMinutes * 60_000;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 24 * 60 * 60_000).toISOString(),
  };
}

/** Today's `YYYY-MM-DD` at a fixed UTC offset. */
export function localToday(utcOffsetMinutes: number, now = new Date()): string {
  return new Date(now.getTime() + utcOffsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10);
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
