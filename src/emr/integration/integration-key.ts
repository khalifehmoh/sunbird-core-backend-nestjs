import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of the `x-integration-key` header with the
 * configured key. An unset key never matches, so the endpoint stays closed
 * until one is configured.
 */
export function integrationKeyMatches(
  expected: string | undefined,
  provided: string | undefined,
): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
