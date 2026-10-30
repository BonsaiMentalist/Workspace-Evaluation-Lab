import { createHash, randomBytes } from 'node:crypto';

/** JSON with object keys sorted at every level, so equal content always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]), // object narrowed above; keys come from the object itself
    );
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export const hashOf = (value: unknown): string => sha256(canonicalJson(value));

const RANDOM_ID_BYTES = 4;
const TIME_RADIX = 36;

/** New record id such as "result-mhd2k1x0-9f3a1c2e": readable prefix, time part, random part. */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(TIME_RADIX)}-${randomBytes(RANDOM_ID_BYTES).toString('hex')}`;
}

export const nowIso = (): string => new Date().toISOString();
