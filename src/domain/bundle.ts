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
import { freezeIntact } from './cases.js';
import { hashOf, nowIso } from './hash.js';
import type { LabSnapshot } from './lookup.js';
import { ASSESSED_BY_LABELS, assessedBy } from './scoring.js';

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

interface Accumulator {
  readonly additions: Record<Collection, unknown[]>;
  readonly skippedIdentical: number;
  readonly problems: string[];
}

function referenceProblems(collection: Collection, record: Record<string, unknown>, known: { readonly cases: ReadonlySet<string>; readonly outputs: ReadonlySet<string> }): string | null {
  const caseRef = `${String(record['caseId'])}@${String(record['caseVersion'])}`;
  const needsCase: ReadonlySet<Collection> = new Set<Collection>(['outputs', 'results', 'comparisons']);
  if (needsCase.has(collection) && !known.cases.has(caseRef)) return `refers to case ${caseRef.replace('@', ' version ')}, which is neither in the lab nor in the file`;
  const outputIds = collection === 'results' ? [String(record['outputId'])] : [];
  const entryOutputs = collection === 'comparisons' ? ((record['entries'] as Array<{ outputId: string }> | undefined) ?? []).map((e) => e.outputId) : []; // entries already validated by the schema
  const missing = [...outputIds, ...entryOutputs].filter((id) => !known.outputs.has(id));
  return missing.length ? `refers to output(s) ${missing.join(', ')}, which are neither in the lab nor in the file` : null;
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

  // Parse first, so references can be checked against both the lab and the file.
  const parsed = COLLECTION_ORDER.map((collection) => ({
    collection,
    items: (bundle[collection] as unknown[]).map((rawRecord, index) => ({ index, result: COLLECTIONS[collection].schema.safeParse(rawRecord, { reportInput: true }) })),
  }));
  const validOf = (collection: Collection): Array<Record<string, unknown>> =>
    (parsed.find((p) => p.collection === collection)?.items ?? []).flatMap((i) => (i.result.success ? [i.result.data as Record<string, unknown>] : [])); // schema-validated records
  const known = {
    cases: new Set([...existing.cases.keys(), ...validOf('cases').map(versionedKey)]),
    outputs: new Set([...existing.outputs.keys(), ...validOf('outputs').map(idKey)]),
  };

  const outcome = parsed.reduce<Accumulator>(
    (acc, { collection, items }) =>
      items.reduce<Accumulator>((inner, { index, result }) => {
        const spec = COLLECTIONS[collection];
        const name = `${spec.label} ${index + 1}`;
        if (!result.success) return { ...inner, problems: [...inner.problems, `${name}: ${describeZodError(result.error)}`] };
        const record = result.data as Record<string, unknown>; // validated just above
        const key = spec.key(record);
        const current = existing[collection].get(key);
        if (current !== undefined) {
          return hashOf(current) === hashOf(record)
            ? { ...inner, skippedIdentical: inner.skippedIdentical + 1 }
            : { ...inner, problems: [...inner.problems, `${name} (${key}) differs from the record already in the lab; the existing record was kept.`] };
        }
        if (collection === 'cases' && !freezeIntact(EvaluationCase.parse(record)))
          return { ...inner, problems: [...inner.problems, `${name} (${key}) is marked frozen but its content no longer matches its freeze hash; it was not imported.`] };
        const refProblem = referenceProblems(collection, record, known);
        if (refProblem) return { ...inner, problems: [...inner.problems, `${name} (${key}) ${refProblem}; it was not imported.`] };
        return { ...inner, additions: { ...inner.additions, [collection]: [...inner.additions[collection], record] } };
      }, acc),
    { additions: emptyAdditions() as unknown as Record<Collection, unknown[]>, skippedIdentical: 0, problems: [] }, // same shape, widened for accumulation
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
