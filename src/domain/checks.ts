/**
 * Deterministic checks: verifiable properties of an output's text, such as a
 * required statement, a forbidden claim, a structured label or a cited
 * evidence id. They are reproducible (same output and case, same findings)
 * and every finding says what the check can and cannot establish. They never
 * judge whether a statement is true or well reasoned.
 */
import type { DeterministicCheck, EvaluationCase, Finding, Outcome, SavedOutput } from './schemas.js';
import { hashOf } from './hash.js';

export interface CheckOutcome {
  readonly checkId: string;
  readonly criterionId: string;
  readonly passed: boolean;
  readonly detail: string;
  readonly establishes: string;
  readonly cannotEstablish: string;
}

type CheckOf<TType extends DeterministicCheck['type']> = Extract<DeterministicCheck, { type: TType }>;

interface CheckDefinition<TType extends DeterministicCheck['type']> {
  readonly plainName: string;
  readonly establishes: string;
  readonly cannotEstablish: string;
  readonly run: (check: CheckOf<TType>, output: string) => { readonly passed: boolean; readonly detail: string };
}

type CheckTable = { readonly [TType in DeterministicCheck['type']]: CheckDefinition<TType> };

/** Version of the check engine. Bump when any check's behaviour changes, so old results stay explainable. */
export const CHECK_ENGINE_VERSION = 'checks-1';
export const CHECK_ENGINE_NAME = 'Evaluation Lab automatic checks';

// Runs of whitespace collapse to one space: "a  b\tc" → "a b c"; "abc" is unchanged.
// https://regex101.com/?flavor=javascript&regex=%5Cs%2B&flags=g&testString=a%20%20b%09c%0Aabc
const WHITESPACE_RUN = /\s+/g;
// Curly single quotes become straight ones: "’ok’" → "'ok'"; "'ok'" is unchanged.
// https://regex101.com/?flavor=javascript&regex=%5B%E2%80%98%E2%80%99%5D&flags=g&testString=%E2%80%99ok%E2%80%99%0A'ok'
const CURLY_SINGLE = /[‘’]/g;
// Curly double quotes become straight ones: "“ok”" → "\"ok\""; "\"ok\"" is unchanged.
// https://regex101.com/?flavor=javascript&regex=%5B%E2%80%9C%E2%80%9D%5D&flags=g&testString=%E2%80%9Cok%E2%80%9D%0A%22ok%22
const CURLY_DOUBLE = /[“”]/g;
// An evidence citation in square brackets; captures the id. "see [E1] and [E2]" → "E1", "E2"; "see E1" has none.
// https://regex101.com/?flavor=javascript&regex=%5C%5B(%5BA-Za-z0-9_-%5D%7B1%2C40%7D)%5C%5D&flags=g&testString=see%20%5BE1%5D%20and%20%5BE2%5D%0Asee%20E1
const CITATION = /\[([A-Za-z0-9_-]{1,40})\]/g;
// A fenced code block, optionally tagged json; captures its body. "```json {\"a\":1} ```" → "{\"a\":1} "; "no fence" has none.
// https://regex101.com/?flavor=javascript&regex=%60%60%60(%3F%3Ajson)%3F%5Cs*(%5B%5Cs%5CS%5D*%3F)%60%60%60&flags=i&testString=%60%60%60json%20%7B%22a%22%3A1%7D%20%60%60%60%0Ano%20fence
const FENCED_BLOCK = /```(?:json)?\s*([\s\S]*?)```/i;
// One word: any run of non-space characters. "three short words" has three; "   " has none.
// https://regex101.com/?flavor=javascript&regex=%5CS%2B&flags=g&testString=three%20short%20words%0A%20%20%20
const WORD = /\S+/g;
// Markdown emphasis and trailing punctuation around a label value: "**Invalid.**" → "Invalid"; "Invalid" is unchanged.
// https://regex101.com/?flavor=javascript&regex=%5E%5B*_%60%5Cs%5D%2B%7C%5B*_%60.%3B%2C!%5Cs%5D%2B%24&flags=g&testString=**Invalid.**%0AInvalid
const VALUE_DECORATION = /^[*_`\s]+|[*_`.;,!\s]+$/g;
// Characters with special meaning in a regex, escaped before a label is built into a pattern: "a.b" → "a\\.b"; "ab" is unchanged.
// https://regex101.com/?flavor=javascript&regex=%5B.*%2B%3F%5E%24%7B%7D()%7C%5B%5C%5D%5C%5C%5D&flags=g&testString=a.b%0Aab
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

const JSON_OPEN = '{';
const JSON_CLOSE = '}';
const NOT_FOUND = -1;

export function normalizeText(text: string): string {
  return text.replace(CURLY_SINGLE, "'").replace(CURLY_DOUBLE, '"').replace(WHITESPACE_RUN, ' ').trim().toLowerCase();
}

const quoteList = (items: readonly string[]): string => items.map((i) => `"${i}"`).join(', ');

function findLabelValue(output: string, label: string): string | null {
  const escaped = label.replace(REGEX_SPECIAL, '\\$&');
  // A line "<label>: <value>", label optionally in markdown emphasis; captures the value.
  // With label "Classification": "Classification: Invalid" → "Invalid"; "**Classification**: Valid" → "Valid"; rejects "Class: x".
  // https://regex101.com/?flavor=javascript&regex=%5E%5Cs*%5B*_%60%5D*%5Cs*Classification%5Cs*%5B*_%60%5D*%5Cs*%3A%5Cs*(.%2B)%24&flags=gim&testString=Classification%3A%20Invalid%0A**Classification**%3A%20Valid%0AClass%3A%20x
  const linePattern = new RegExp(`^\\s*[*_\`]*\\s*${escaped}\\s*[*_\`]*\\s*:\\s*(.+)$`, 'im');
  const value = linePattern.exec(output)?.[1];
  return value === undefined ? null : value.replace(VALUE_DECORATION, '');
}

function tryParseObject(candidate: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null; // shape checked on this line
  } catch {
    return null;
  }
}

/** The first JSON object in an output: the whole text, a fenced block, or the outermost braces. */
export function extractJsonObject(output: string): Record<string, unknown> | null {
  const fenced = FENCED_BLOCK.exec(output)?.[1];
  const start = output.indexOf(JSON_OPEN);
  const end = output.lastIndexOf(JSON_CLOSE);
  const braces = start !== NOT_FOUND && end > start ? output.slice(start, end + 1) : null;
  const candidates = [output.trim(), fenced, braces].filter((c): c is string => Boolean(c));
  return candidates.map(tryParseObject).find((parsed) => parsed !== null) ?? null;
}

function readPath(root: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    return Object.hasOwn(node, key) ? (node as Record<string, unknown>)[key] : undefined; // own keys only, narrowed above
  }, root);
}

function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return Boolean(value.length);
  return true;
}

const CHECKS: CheckTable = {
  'required-phrase': {
    plainName: 'Required wording',
    establishes: 'The output contains the required wording.',
    cannotEstablish: 'Whether the statement is correct, meant sincerely, or used in the right sense. Different wording with the same meaning is not recognised.',
    run: (check, output) => {
      const text = normalizeText(output);
      const found = check.phrases.filter((p) => text.includes(normalizeText(p)));
      const passed = check.match === 'all' ? found.length === check.phrases.length : Boolean(found.length);
      const wanted = `${check.match === 'all' ? 'all of' : 'one of'} ${quoteList(check.phrases)}`;
      return { passed, detail: passed ? `Found ${quoteList(found)}.` : `Expected ${wanted}; found ${found.length ? quoteList(found) : 'none'}.` };
    },
  },
  'forbidden-phrase': {
    plainName: 'Forbidden claim',
    establishes: 'None of the listed claims appears in these words.',
    cannotEstablish: 'The same claim made in different words, or implied, is not caught.',
    run: (check, output) => {
      const text = normalizeText(output);
      const found = check.phrases.filter((p) => text.includes(normalizeText(p)));
      return { passed: !found.length, detail: found.length ? `Found forbidden wording ${quoteList(found)}.` : 'None of the forbidden wording was found.' };
    },
  },
  'expected-label': {
    plainName: 'Expected classification',
    establishes: 'The output states the expected value on a labelled line.',
    cannotEstablish: 'Whether the reasoning behind the value is sound; a correct label can come from wrong reasoning.',
    run: (check, output) => {
      const value = findLabelValue(output, check.label);
      if (value === null) return { passed: false, detail: `No line starting "${check.label}:" was found.` };
      const passed = check.accepted.some((a) => normalizeText(a) === normalizeText(value));
      return { passed, detail: `"${check.label}" is "${value}"; accepted: ${quoteList(check.accepted)}.` };
    },
  },
  'required-field': {
    plainName: 'Required structured field',
    establishes: 'The output includes a JSON object with this field filled in.',
    cannotEstablish: 'Whether the field’s content is correct.',
    run: (check, output) => {
      const json = extractJsonObject(output);
      if (!json) return { passed: false, detail: 'No JSON object was found in the output.' };
      const passed = isFilled(readPath(json, check.field));
      return { passed, detail: passed ? `Field "${check.field}" is present and filled in.` : `Field "${check.field}" is missing or empty.` };
    },
  },
  'evidence-reference': {
    plainName: 'Evidence cited',
    establishes: 'The output cites enough of the listed evidence ids, like [E1].',
    cannotEstablish: 'Whether the cited evidence actually supports the claim it is attached to.',
    run: (check, output) => {
      const cited = new Set([...output.matchAll(CITATION)].map((m) => m[1] ?? ''));
      const matching = check.refs.filter((r) => cited.has(r));
      const passed = matching.length >= check.min;
      return { passed, detail: `Cited ${matching.length ? quoteList(matching) : 'none'} of ${quoteList(check.refs)}; needed at least ${check.min}.` };
    },
  },
  'max-words': {
    plainName: 'Length limit',
    establishes: 'The output stays within the word limit.',
    cannotEstablish: 'Whether the length is appropriate for the content.',
    run: (check, output) => {
      const words = output.match(WORD)?.length ?? 0;
      return { passed: words <= check.max, detail: `${words} words; limit ${check.max}.` };
    },
  },
};

function definitionFor(check: DeterministicCheck): CheckDefinition<DeterministicCheck['type']> {
  // The table is keyed by check type, so the entry always matches this check's type.
  return CHECKS[check.type] as CheckDefinition<DeterministicCheck['type']>;
}

export function describeCheck(check: DeterministicCheck): { readonly plainName: string; readonly establishes: string; readonly cannotEstablish: string } {
  const { plainName, establishes, cannotEstablish } = definitionFor(check);
  return { plainName, establishes, cannotEstablish };
}

export function runCheck(check: DeterministicCheck, output: string): CheckOutcome {
  const definition = definitionFor(check);
  const { passed, detail } = definition.run(check, output);
  return {
    checkId: check.id,
    criterionId: check.criterionId,
    passed,
    detail,
    establishes: definition.establishes,
    cannotEstablish: definition.cannotEstablish,
  };
}

/** Turns check outcomes into one finding per criterion: pass only if every check for it passed. */
export function findingsFromChecks(outcomes: readonly CheckOutcome[]): Finding[] {
  const criterionIds = [...new Set(outcomes.map((o) => o.criterionId))];
  return criterionIds.map((criterionId) => {
    const mine = outcomes.filter((o) => o.criterionId === criterionId);
    const outcome: Outcome = mine.every((o) => o.passed) ? 'pass' : 'fail';
    const lines = mine.map((o) => `${o.passed ? 'Passed' : 'Failed'}: ${o.detail} (This shows: ${o.establishes} It cannot show: ${o.cannotEstablish})`);
    return {
      criterionId,
      outcome,
      rating: null,
      explanation: lines.join('\n'),
      evidenceRefs: [],
      method: 'deterministic',
      checkId: mine.length === 1 ? (mine[0]?.checkId ?? null) : null,
      correctedByOwner: false,
    };
  });
}

export interface CheckRun {
  readonly outcomes: readonly CheckOutcome[];
  readonly findings: readonly Finding[];
  /** Same case version, same output text, same engine version → same fingerprint and same findings. */
  readonly fingerprint: string;
}

export function runCaseChecks(testCase: EvaluationCase, output: SavedOutput): CheckRun {
  const outcomes = testCase.checks.map((check) => runCheck(check, output.text));
  return {
    outcomes,
    findings: findingsFromChecks(outcomes),
    fingerprint: hashOf({ engine: CHECK_ENGINE_VERSION, checks: testCase.checks, text: output.text }),
  };
}
