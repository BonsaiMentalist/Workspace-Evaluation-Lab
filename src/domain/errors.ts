/** Turns validation failures into short messages a non-engineer can act on. */
import type { z } from 'zod';

const MAX_SHOWN_ISSUES = 5;
const MAX_INPUT_PREVIEW = 60;
const MISSING_TYPE = 'undefined';

function previewInput(input: unknown): string {
  if (input === undefined) return '';
  const raw = typeof input === 'string' ? `"${input}"` : JSON.stringify(input) ?? String(input);
  return raw.length > MAX_INPUT_PREVIEW ? `${raw.slice(0, MAX_INPUT_PREVIEW)}…` : raw;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.length ? issue.path.map(String).join(' → ') : 'the file';
  const missing = issue.code === 'invalid_type' && issue.message.endsWith(MISSING_TYPE);
  if (missing) return `${where}: this field is required but missing.`;
  const got = 'input' in issue ? previewInput(issue.input) : '';
  return `${where}: ${issue.message}${got ? ` (got ${got})` : ''}.`;
}

/** One line per problem, at most a handful, so a long file of mistakes stays readable. */
export function describeZodError(error: z.ZodError): string {
  const shown = error.issues.slice(0, MAX_SHOWN_ISSUES).map(describeIssue);
  const hidden = error.issues.length - shown.length;
  return [...shown, ...(hidden > 0 ? [`…and ${hidden} more problem(s).`] : [])].join(' ');
}

/** A record whose schema version is newer than this app understands is refused, never guessed at. */
export function schemaVersionProblem(raw: unknown, expectedSchema: string, supportedVersion: number): string | null {
  if (raw === null || typeof raw !== 'object') return 'The file does not contain a JSON object.';
  const record = raw as { schema?: unknown; schemaVersion?: unknown }; // fields read only to give a clearer message; full validation follows
  if (record.schema !== expectedSchema) return `This is not a "${expectedSchema}" file (its "schema" field is ${previewInput(record.schema) || 'missing'}).`;
  if (typeof record.schemaVersion === 'number' && record.schemaVersion > supportedVersion)
    return `This file uses format version ${record.schemaVersion}, made by a newer version of the lab. This version understands up to ${supportedVersion}.`;
  return null;
}
