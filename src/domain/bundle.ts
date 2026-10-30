/**
 * Export and re-import of lab records, plus a flat CSV of results.
 *
 * Invariants a future edit must keep:
 * - Import never overwrites. A record whose id (and version) already exists
 *   is skipped if identical and reported as a conflict if different.
 * - Records keep the provenance, evaluator identity and review history they
 *   were exported with.
 * - Every record is validated on its own; a bad record is reported and
 *   skipped, and references to missing cases or outputs are refused.
 * - A frozen case whose content no longer matches its freeze hash is refused.
 */
import type { z } from 'zod';
import type { EvaluationResult, ExportBundle } from './schemas.js';
import {
  BlindedComparison,
  EvaluationCase,
  EvaluationResult as EvaluationResultSchema,
  ExportBundle as ExportBundleSchema,
  FORMAT_VERSION,
  ImportBatchRecord,
  ProductionObservation,
  SavedOutput,
  SpecialistProfile,
} from './schemas.js';
import { describeZodError, schemaVersionProblem } from './errors.js';
import { lifecycleProblems } from './cases.js';
import { findingProblems } from './imports.js';
import { hashOf, nowIso } from './hash.js';
import type { LabSnapshot } from './lookup.js';
import { ASSESSED_BY_LABELS, assessedBy, scoreFindings } from './scoring.js';

export const APP_NAME = 'Specialist Evaluation Lab';
export const APP_VERSION = '0.1.0';
const BUNDLE_SCHEMA = 'eval-lab/export-bundle';

type Collection = keyof LabSnapshot;

interface CollectionSpec {
  readonly schema: z.ZodType;
  readonly key: (record: Record<string, unknown>) => string;
  readonly label: string;
}

const idKey = (r: Record<string, unknown>): string => String(r['id']);
const versionedKey = (r: Record<string, unknown>): string => `${String(r['id'])}@${String(r['version'])}`;

const COLLECTIONS = {
  profiles: { schema: SpecialistProfile, key: versionedKey, label: 'profile' },
  cases: { schema: EvaluationCase, key: versionedKey, label: 'case' },
  outputs: { schema: SavedOutput, key: idKey, label: 'output' },
  results: { schema: EvaluationResultSchema, key: idKey, label: 'result' },
  comparisons: { schema: BlindedComparison, key: idKey, label: 'comparison' },
  observations: { schema: ProductionObservation, key: idKey, label: 'observation' },
  importBatches: { schema: ImportBatchRecord, key: idKey, label: 'import batch' },
} as const satisfies Record<Collection, CollectionSpec>;

const COLLECTION_ORDER: readonly Collection[] = ['profiles', 'cases', 'outputs', 'results', 'comparisons', 'observations', 'importBatches'];

export function buildBundle(lab: LabSnapshot, at = nowIso()): ExportBundle {
  return {
    schema: BUNDLE_SCHEMA,
    schemaVersion: FORMAT_VERSION,
    exportedAt: at,
    app: { name: APP_NAME, version: APP_VERSION },
    profiles: [...lab.profiles],
    cases: [...lab.cases],
    outputs: [...lab.outputs],
    results: [...lab.results],
    comparisons: [...lab.comparisons],
    observations: [...lab.observations],
    importBatches: [...lab.importBatches],
  };
}

export interface BundleImport {
  readonly ok: boolean;
  readonly message: string;
  /** New records to add, by collection. Empty when `ok` is false. */
  readonly additions: { readonly [TCollection in Collection]: LabSnapshot[TCollection] };
  readonly skippedIdentical: number;
  readonly problems: readonly string[];
}

const emptyAdditions = (): BundleImport['additions'] => ({ profiles: [], cases: [], outputs: [], results: [], comparisons: [], observations: [], importBatches: [] });

/** Records accepted so far (from the lab or earlier in the file), used to resolve references. */
interface Known {
  readonly profiles: ReadonlyMap<string, SpecialistProfileRecord>;
  readonly cases: ReadonlySet<string>;
  readonly outputs: ReadonlySet<string>;
}

type SpecialistProfileRecord = LabSnapshot['profiles'][number];

const caseKey = (r: Record<string, unknown>): string => `${String(r['caseId'])}@${String(r['caseVersion'])}`;
const profileKey = (r: Record<string, unknown>): string => `${String(r['profileId'])}@${String(r['profileVersion'])}`;
const NEEDS_CASE: ReadonlySet<Collection> = new Set<Collection>(['outputs', 'results', 'comparisons']);
const NEEDS_PROFILE: ReadonlySet<Collection> = new Set<Collection>(['results', 'comparisons']);

function referenceProblem(collection: Collection, record: Record<string, unknown>, known: Known): string | null {
  if (NEEDS_CASE.has(collection) && !known.cases.has(caseKey(record))) return `refers to case ${caseKey(record).replace('@', ' version ')}, which is neither in the lab nor accepted from the file`;
  if (NEEDS_PROFILE.has(collection) && !known.profiles.has(profileKey(record))) return `refers to profile ${profileKey(record).replace('@', ' version ')}, which is neither in the lab nor in the file`;
  const outputIds = collection === 'results' ? [String(record['outputId'])] : [];
  const entryOutputs = collection === 'comparisons' ? ((record['entries'] as Array<{ outputId: string }> | undefined) ?? []).map((e) => e.outputId) : []; // entries already validated by the schema
  const missing = [...outputIds, ...entryOutputs].filter((id) => !known.outputs.has(id));
  return missing.length ? `refers to output(s) ${missing.join(', ')}, which are neither in the lab nor accepted from the file` : null;
}

/** The same rules the app applies when records are made inside the lab. Returns a problem, or the record to store. */
function enforceRules(collection: Collection, record: Record<string, unknown>, known: Known): Record<string, unknown> | string {
  if (collection === 'cases') {
    const problems = lifecycleProblems(EvaluationCase.parse(record));
    return problems.length ? problems.join('; ') : record;
  }
  if (collection === 'results') {
    const result = EvaluationResultSchema.parse(record);
    const profile = known.profiles.get(profileKey(record));
    if (!profile) return 'has no profile to score against';
    const problems = findingProblems(result.findings, profile);
    if (problems.length) return problems.join(' ');
    if (result.evaluator.type === 'ai-reviewer' && result.review.state === 'not-required') return 'is an AI-reviewer assessment marked as needing no spot-check';
    const corrected = result.review.state === 'corrected';
    if (corrected !== Boolean(result.review.originalFindings) || (!corrected && result.findings.some((f) => f.correctedByOwner)))
      return 'has an inconsistent correction record (corrected findings without the reviewer’s originals, or the reverse)';
    // The stored outcome is recomputed, so an edited file can never hide a mandatory failure.
    return { ...record, overall: scoreFindings(profile, result.findings).overall };
  }
  if (collection === 'comparisons') {
    const comparison = BlindedComparison.parse(record);
    if (comparison.evaluator?.type === 'ai-reviewer' && comparison.review.state === 'not-required') return 'is an AI-reviewer comparison marked as needing no spot-check';
    if ((comparison.status === 'recorded') !== Boolean(comparison.preference)) return 'has a status that does not match whether a preference was recorded';
    if (comparison.review.state === 'rejected' && comparison.status === 'recorded') return 'records a preference that was rejected';
  }
  return record;
}

interface Accumulator {
  readonly additions: Record<Collection, Array<Record<string, unknown>>>;
  readonly skippedIdentical: number;
  readonly problems: string[];
}

export function importBundle(raw: unknown, lab: LabSnapshot): BundleImport {
  const versionProblem = schemaVersionProblem(raw, BUNDLE_SCHEMA, FORMAT_VERSION);
  const fail = (message: string): BundleImport => ({ ok: false, message, additions: emptyAdditions(), skippedIdentical: 0, problems: [] });
  if (versionProblem) return fail(versionProblem);
  const envelope = ExportBundleSchema.safeParse(raw, { reportInput: true });
  if (!envelope.success) return fail(`The file is not a valid lab export. ${describeZodError(envelope.error)}`);
  const bundle = envelope.data;

  const existing = Object.fromEntries(
    COLLECTION_ORDER.map((c) => [c, new Map((lab[c] as readonly unknown[]).map((r) => [COLLECTIONS[c].key(r as Record<string, unknown>), r]))]), // lab records are plain objects
  ) as Record<Collection, Map<string, unknown>>; // built from COLLECTION_ORDER, so every collection is present

  const knownFrom = (acc: Accumulator): Known => ({
    profiles: new Map([...lab.profiles, ...(acc.additions.profiles as SpecialistProfileRecord[])].map((p) => [`${p.id}@${p.version}`, p])), // accepted profiles were schema-validated
    cases: new Set([...existing.cases.keys(), ...acc.additions.cases.map(versionedKey)]),
    outputs: new Set([...existing.outputs.keys(), ...acc.additions.outputs.map(idKey)]),
  });

  // Collections are processed in dependency order (profiles, cases, outputs, results…), so a reference is
  // only accepted when what it points at was itself accepted.
  const outcome = COLLECTION_ORDER.reduce<Accumulator>(
    (acc, collection) =>
      (bundle[collection] as unknown[]).reduce<Accumulator>((inner, rawRecord, index) => {
        const spec = COLLECTIONS[collection];
        const name = `${spec.label} ${index + 1}`;
        const parsed = spec.schema.safeParse(rawRecord, { reportInput: true });
        if (!parsed.success) return { ...inner, problems: [...inner.problems, `${name}: ${describeZodError(parsed.error)}`] };
        const record = parsed.data as Record<string, unknown>; // validated just above
        const key = spec.key(record);
        const current = existing[collection].get(key);
        const refuse = (why: string): Accumulator => ({ ...inner, problems: [...inner.problems, `${name} (${key}) ${why}; it was not imported.`] });
        if (current !== undefined) {
          return hashOf(current) === hashOf(record)
            ? { ...inner, skippedIdentical: inner.skippedIdentical + 1 }
            : { ...inner, problems: [...inner.problems, `${name} (${key}) differs from the record already in the lab; the existing record was kept.`] };
        }
        if (inner.additions[collection].some((r) => spec.key(r) === key)) return refuse('appears more than once in the file');
        const known = knownFrom(inner);
        const refProblem = referenceProblem(collection, record, known);
        if (refProblem) return refuse(refProblem);
        const checked = enforceRules(collection, record, known);
        if (typeof checked === 'string') return refuse(checked);
        return { ...inner, additions: { ...inner.additions, [collection]: [...inner.additions[collection], checked] } };
      }, acc),
    { additions: emptyAdditions() as unknown as Accumulator['additions'], skippedIdentical: 0, problems: [] }, // same shape, widened for accumulation
  );
  const added = COLLECTION_ORDER.reduce((sum, c) => sum + outcome.additions[c].length, 0);
  return {
    ok: true,
    message: `${added} record(s) added, ${outcome.skippedIdentical} already present, ${outcome.problems.length} not imported.`,
    additions: outcome.additions as unknown as BundleImport['additions'], // every entry was parsed by its collection's schema
    skippedIdentical: outcome.skippedIdentical,
    problems: outcome.problems,
  };
}

// ---------------------------------------------------------------------------
// CSV export of flat result summaries
// ---------------------------------------------------------------------------

// A spreadsheet treats a cell starting with one of these as a formula, so such cells are prefixed with a quote.
const FORMULA_START = new Set(['=', '+', '-', '@', '\t', '\r']);
const NEEDS_QUOTES = [',', '"', '\n', '\r'];

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  const safe = FORMULA_START.has(text.charAt(0)) ? `'${text}` : text;
  return NEEDS_QUOTES.some((c) => safe.includes(c)) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const CSV_COLUMNS: ReadonlyArray<readonly [string, (r: EvaluationResult) => string | number | null]> = [
  ['result_id', (r) => r.id],
  ['recorded_at', (r) => r.createdAt],
  ['specialist', (r) => r.profileId],
  ['case_id', (r) => r.caseId],
  ['case_version', (r) => r.caseVersion],
  ['split', (r) => r.split],
  ['rubric_version', (r) => r.profileVersion],
  ['output_id', (r) => r.outputId],
  ['model', (r) => r.model.model],
  ['provider', (r) => r.model.provider],
  ['effort', (r) => r.model.effort],
  ['configuration', (r) => r.configuration.configurationId],
  ['assessed_by', (r) => ASSESSED_BY_LABELS[assessedBy(r)]],
  ['evaluator', (r) => r.evaluator.name],
  ['review_state', (r) => r.review.state],
  ['overall', (r) => r.overall],
  ['passed', (r) => r.findings.filter((f) => f.outcome === 'pass').length],
  ['partly_met', (r) => r.findings.filter((f) => f.outcome === 'partial').length],
  ['failed', (r) => r.findings.filter((f) => f.outcome === 'fail').length],
  ['inconclusive', (r) => r.findings.filter((f) => f.outcome === 'inconclusive').length],
  ['not_applicable', (r) => r.findings.filter((f) => f.outcome === 'not-applicable').length],
  ['workspace_job', (r) => r.workspace.job],
  ['workspace_piece', (r) => r.workspace.piece],
  ['workspace_reply', (r) => r.workspace.reply],
  ['origin', (r) => r.provenance.origin],
];

export function resultsCsv(results: readonly EvaluationResult[]): string {
  const header = CSV_COLUMNS.map(([name]) => name).join(',');
  const rows = results.map((r) => CSV_COLUMNS.map(([, read]) => csvCell(read(r))).join(','));
  return `${[header, ...rows].join('\r\n')}\r\n`;
}
