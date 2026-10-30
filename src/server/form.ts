/** Reading submitted form fields safely. Every value is treated as untrusted text. */
import type { Request } from 'express';

export type FormBody = Readonly<Record<string, unknown>>;

const MAX_ROWS = 200;
// Line breaks in any style. "a\r\nb" splits into "a", "b"; "ab" stays whole.
// https://regex101.com/?flavor=javascript&regex=%5Cr%3F%5Cn&flags=g&testString=a%0D%0Ab%0Aab
const LINE_BREAK = /\r?\n/;
const COMMA = ',';
const CHECKED = new Set(['on', 'true', '1', 'yes']);

export function bodyOf(req: Request): FormBody {
  const body: unknown = req.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as FormBody) : {}; // narrowed to a plain object
}

export function text(body: FormBody, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Text with line breaks kept but each line's trailing spaces removed. */
export function longText(body: FormBody, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.replaceAll('\r\n', '\n').trim() : '';
}

export const checkbox = (body: FormBody, key: string): boolean => CHECKED.has(text(body, key).toLowerCase());

export function int(body: FormBody, key: string): number | null {
  const raw = text(body, key);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

export function num(body: FormBody, key: string): number | null {
  const raw = text(body, key);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export const nullable = (value: string): string | null => value || null;

export const lines = (value: string): string[] => value.split(LINE_BREAK).map((l) => l.trim()).filter(Boolean);

export const commaList = (value: string): string[] => value.split(COMMA).map((v) => v.trim()).filter(Boolean);

/** Values of a field that may appear once or many times (checkbox groups). */
export function many(body: FormBody, key: string): string[] {
  const value = body[key];
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Repeated row groups such as `criteria[0][name]`. The form parser may give
 * them as a list or as an object keyed by index; both are accepted.
 */
export function rows(body: FormBody, key: string): FormBody[] {
  const value = body[key];
  const isObject = value !== null && typeof value === 'object';
  const fromObject: unknown[] = isObject ? Object.values(value) : [];
  const items: unknown[] = Array.isArray(value) ? value : fromObject;
  return items.slice(0, MAX_ROWS).filter((item): item is FormBody => item !== null && typeof item === 'object' && !Array.isArray(item));
}
