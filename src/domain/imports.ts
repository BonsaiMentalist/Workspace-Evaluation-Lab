/**
 * Imported outside assessments: criterion-level findings made elsewhere (an
 * AI reviewer run inside AI Workspace, a separate assistant session, or a
 * person) and brought in as a JSON file. The lab never calls an AI service.
 *
 * Invariants a future edit must keep:
 * - Every imported result keeps its evaluator identity and source file.
 * - AI-reviewer results start as "needs spot-check" and count in no report
 *   until the owner accepts or corrects them.
 * - A correction keeps the reviewer's original findings beside the owner's.
 * - The rest of a batch can be accepted together only after the owner has
 *   checked a sample of it one by one.
 * - A malformed entry is rejected with a clear message and never stored;
 *   the batch's valid entries still import.
 */
import type {
  BlindedComparison,
  EvaluationCase,
  EvaluationResult,
  Finding,
  ImportBatchRecord,
  ImportedAssessmentBatch,
  Origin,
  Preference,
  SavedOutput,
  SpecialistProfile,
} from './schemas.js';
import {
  EvaluationResult as EvaluationResultSchema,
  Finding as FindingSchema,
  FORMAT_VERSION,
  ImportedAssessmentBatch as BatchSchema,
  ImportedAssessmentEntry as EntrySchema,
  ImportedComparisonEntry as ComparisonEntrySchema,
} from './schemas.js';
import { describeZodError, schemaVersionProblem } from './errors.js';
import { canEvaluate, LifecycleError } from './cases.js';
import { createComparison } from './comparisons.js';
import { findCase, findOutput, findProfile, profileForCase, type LabSnapshot } from './lookup.js';
import { scoreFindings } from './scoring.js';
import { sha256 } from './hash.js';

export interface Rejection {
  readonly entry: string;
  readonly message: string;
}

export type ImportOutcome =
  | { readonly ok: false; readonly message: string; readonly rejected: readonly Rejection[] }
  | {
      readonly ok: true;
      readonly batch: ImportBatchRecord;
      readonly results: readonly EvaluationResult[];
      readonly comparisons: readonly BlindedComparison[];
      readonly rejected: readonly Rejection[];
    };

export interface ImportContext {
  readonly lab: LabSnapshot;
  readonly sourceFile: string | null;
  readonly now: string;
  readonly origin: Origin;
}

const BATCH_SCHEMA = 'eval-lab/imported-assessment-batch';
const MIN_SPOT_CHECK = 2;
const SPOT_CHECK_SHARE = 0.2;
const DERIVED_ID_LENGTH = 16;
const ENTRY_NAME_PREVIEW = 32;
const SPECIAL_CHOICES: ReadonlySet<string> = new Set(['tie', 'inconclusive']);
const REVIEWED_STATES: ReadonlySet<string> = new Set(['accepted', 'corrected', 'rejected']);

/** How many entries the owner checks one by one before the rest of a batch may be accepted together. */
export const spotCheckSampleSize = (entryCount: number): number =>
  Math.min(entryCount, Math.max(MIN_SPOT_CHECK, Math.ceil(entryCount * SPOT_CHECK_SHARE)));

const derivedId = (prefix: string, batchId: string, entryId: string): string =>
  `${prefix}-${sha256(`${batchId}\u0000${entryId}`).slice(0, DERIVED_ID_LENGTH)}`;

function entryName(raw: unknown, index: number, kind: string): string {
  const entryId = raw !== null && typeof raw === 'object' && 'entryId' in raw ? (raw as { entryId: unknown }).entryId : undefined; // read only to name the entry in messages
  return typeof entryId === 'string' && entryId ? `${kind} ${index + 1} ("${entryId.slice(0, ENTRY_NAME_PREVIEW)}")` : `${kind} ${index + 1}`;
}

interface CaseTarget {
  readonly testCase: EvaluationCase;
  readonly profile: SpecialistProfile;
}

function resolveCase(lab: LabSnapshot, caseId: string, caseVersion: number, profileVersion: number | null): CaseTarget | string {
  const testCase = findCase(lab, caseId, caseVersion);
  if (!testCase) return `case "${caseId}" version ${caseVersion} does not exist in this lab.`;
  if (!canEvaluate(testCase)) return `case "${caseId}" version ${caseVersion} is ${testCase.status}${testCase.archived ? ' and archived' : ''}; only frozen cases can be evaluated.`;
  const profile = profileVersion === null ? profileForCase(lab, testCase) : findProfile(lab, testCase.specialistId, profileVersion);
  if (!profile) return `profile "${testCase.specialistId}" version ${profileVersion ?? testCase.profileVersion ?? '?'} does not exist.`;
  return { testCase, profile };
}

function outputProblem(output: SavedOutput | undefined, outputId: string, testCase: EvaluationCase): string | null {
  if (!output) return `output "${outputId}" does not exist in this lab.`;
  if (output.caseId !== testCase.id || output.caseVersion !== testCase.version)
    return `output "${outputId}" belongs to case "${output.caseId}" version ${output.caseVersion}, not "${testCase.id}" version ${testCase.version}.`;
  return null;
}

/** Problems with findings that are well-formed but don't fit the profile. */
export function findingProblems(findings: readonly Finding[], profile: SpecialistProfile): string[] {
  const criteria = new Map(profile.criteria.map((c) => [c.id, c]));
  const ids = findings.map((f) => f.criterionId);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].map((id) => `criterion "${id}" is assessed twice.`);
  const unknown = ids.filter((id) => !criteria.has(id)).map((id) => `criterion "${id}" is not in profile "${profile.id}" version ${profile.version}.`);
  const scales = findings.flatMap((f) => {
    const scale = criteria.get(f.criterionId)?.scale;
    if (!f.rating || !scale) return [];
    if (scale.kind !== 'rating') return [`criterion "${f.criterionId}" has no rating scale, but a rating was given.`];
    return f.rating.min === scale.min && f.rating.max === scale.max ? [] : [`criterion "${f.criterionId}" uses a ${scale.min}–${scale.max} scale, but the rating used ${f.rating.min}–${f.rating.max}.`];
  });
  return [...duplicates, ...unknown, ...scales];
}

function buildResult(batch: ImportedAssessmentBatch, raw: unknown, ctx: ImportContext): EvaluationResult | string {
  const parsed = EntrySchema.safeParse(raw, { reportInput: true });
  if (!parsed.success) return describeZodError(parsed.error);
  const entry = parsed.data;
  const target = resolveCase(ctx.lab, entry.caseId, entry.caseVersion, entry.profileVersion);
  if (typeof target === 'string') return target;
  const output = findOutput(ctx.lab, entry.outputId);
  const outProblem = outputProblem(output, entry.outputId, target.testCase);
  if (outProblem || !output) return outProblem ?? 'output missing.';
  const findings = entry.findings.map((f) => ({ ...f, correctedByOwner: false }));
  const problems = findingProblems(findings, target.profile);
  if (problems.length) return problems.join(' ');
  const isAi = batch.evaluator.type === 'ai-reviewer';
  return EvaluationResultSchema.parse({
    schema: 'eval-lab/evaluation-result',
    schemaVersion: FORMAT_VERSION,
    id: derivedId('imp', batch.batchId, entry.entryId),
    runId: batch.batchId,
    caseId: target.testCase.id,
    caseVersion: target.testCase.version,
    split: target.testCase.split,
    profileId: target.profile.id,
    profileVersion: target.profile.version,
    outputId: output.id,
    model: output.producedBy,
    configuration: output.configuration,
    workspace: output.workspace,
    resources: output.resources,
    methods: [...new Set(findings.map((f) => f.method))],
    evaluator: { ...batch.evaluator, date: batch.evaluator.date ?? batch.producedAt },
    findings,
    overall: scoreFindings(target.profile, findings).overall,
    overallNote: entry.overallNote,
    uncertainty: entry.uncertainty,
    limitations: entry.limitations,
    review: { state: isAi ? 'needs-spot-check' : 'not-required' },
    importRef: { batchId: batch.batchId, entryId: entry.entryId },
    provenance: { origin: ctx.origin, source: 'file-import', sourceFile: ctx.sourceFile, importedAt: ctx.now },
    createdAt: ctx.now,
  });
}

function buildComparison(batch: ImportedAssessmentBatch, raw: unknown, ctx: ImportContext): BlindedComparison | string {
  const parsed = ComparisonEntrySchema.safeParse(raw, { reportInput: true });
  if (!parsed.success) return describeZodError(parsed.error);
  const entry = parsed.data;
  const target = resolveCase(ctx.lab, entry.caseId, entry.caseVersion, null);
  if (typeof target === 'string') return target;
  const outputProblems = entry.outputIds.flatMap((id) => outputProblem(findOutput(ctx.lab, id), id, target.testCase) ?? []);
  if (outputProblems.length) return outputProblems.join(' ');
  if (new Set(entry.outputIds).size !== entry.outputIds.length) return 'an output is listed twice.';
  const validChoice = (preferred: string): boolean => SPECIAL_CHOICES.has(preferred) || entry.outputIds.includes(preferred);
  const badChoices = [entry.overall.preferred, ...entry.perCriterion.map((p) => p.preferred)].filter((p) => !validChoice(p));
  if (badChoices.length) return `"preferred" must be one of the compared output ids, "tie" or "inconclusive"; got ${badChoices.map((b) => `"${b}"`).join(', ')}.`;
  const criterionIds = new Set(target.profile.criteria.map((c) => c.id));
  const unknown = entry.perCriterion.map((p) => p.criterionId).filter((id) => !criterionIds.has(id));
  if (unknown.length) return `criteria not in the profile: ${unknown.join(', ')}.`;

  const base = createComparison(
    {
      id: derivedId('cmp', batch.batchId, entry.entryId),
      caseId: target.testCase.id,
      caseVersion: target.testCase.version,
      profileId: target.profile.id,
      profileVersion: target.profile.version,
      outputIds: entry.outputIds,
      criterionIds: entry.perCriterion.map((p) => p.criterionId),
      provenance: { origin: ctx.origin, source: 'file-import', sourceFile: ctx.sourceFile, importedAt: ctx.now, note: '' },
    },
    ctx.now,
  );
  const toChoice = (preferred: string): Preference['overall']['choice'] => {
    if (preferred === 'tie' || preferred === 'inconclusive') return preferred;
    return base.entries.find((e) => e.outputId === preferred)?.label ?? 'inconclusive';
  };
  const importedPreference: Preference = {
    overall: { choice: toChoice(entry.overall.preferred), reason: entry.overall.reason },
    perCriterion: entry.perCriterion.map((p) => ({ criterionId: p.criterionId, choice: toChoice(p.preferred), reason: p.reason })),
  };
  const isAi = batch.evaluator.type === 'ai-reviewer';
  return {
    ...base,
    importedPreference,
    evaluator: { ...batch.evaluator, date: batch.evaluator.date ?? batch.producedAt },
    // A person's imported preference is already recorded; an AI reviewer's waits for the owner, identities still hidden.
    status: isAi ? 'open' : 'recorded',
    preference: isAi ? null : importedPreference,
    recordedAt: isAi ? null : ctx.now,
    review: { state: isAi ? 'needs-spot-check' : 'not-required', decidedAt: null, decidedBy: null, via: null, note: '', originalFindings: null },
    importRef: { batchId: batch.batchId, entryId: entry.entryId },
  };
}

interface Built<TRecord> {
  readonly records: TRecord[];
  readonly rejected: Rejection[];
}

function buildAll<TRecord>(rawEntries: readonly unknown[], kind: string, build: (raw: unknown) => TRecord | string): Built<TRecord> {
  return rawEntries.reduce<Built<TRecord>>(
    (acc, raw, index) => {
      const name = entryName(raw, index, kind);
      const entryId = (raw as { entryId?: unknown } | null)?.entryId; // read only to detect duplicates; the entry is validated in build()
      const duplicate = typeof entryId === 'string' && rawEntries.slice(0, index).some((other) => (other as { entryId?: unknown } | null)?.entryId === entryId);
      const built = duplicate ? `entry id "${entryId}" is used more than once in this file.` : build(raw);
      return typeof built === 'string'
        ? { ...acc, rejected: [...acc.rejected, { entry: name, message: `${name} was rejected: ${built}` }] }
        : { ...acc, records: [...acc.records, built] };
    },
    { records: [], rejected: [] },
  );
}

export function importAssessmentBatch(raw: unknown, ctx: ImportContext): ImportOutcome {
  const versionProblem = schemaVersionProblem(raw, BATCH_SCHEMA, FORMAT_VERSION);
  if (versionProblem) return { ok: false, message: versionProblem, rejected: [] };
  const envelope = BatchSchema.safeParse(raw, { reportInput: true });
  if (!envelope.success) return { ok: false, message: `The file is not a valid assessment batch. ${describeZodError(envelope.error)}`, rejected: [] };
  const batch = envelope.data;
  const previous = ctx.lab.importBatches.find((b) => b.id === batch.batchId);
  if (previous) return { ok: false, message: `Batch "${batch.batchId}" was already imported on ${previous.importedAt}. Nothing was changed.`, rejected: [] };

  const assessments = buildAll(batch.assessments, 'Assessment', (entry) => buildResult(batch, entry, ctx));
  const comparisons = buildAll(batch.comparisons, 'Comparison', (entry) => buildComparison(batch, entry, ctx));
  const rejected = [...assessments.rejected, ...comparisons.rejected];
  if (!assessments.records.length && !comparisons.records.length)
    return { ok: false, message: 'No entry in this file could be imported. Nothing was changed.', rejected };

  const record: ImportBatchRecord = {
    schema: 'eval-lab/import-batch-record',
    schemaVersion: FORMAT_VERSION,
    id: batch.batchId,
    evaluator: batch.evaluator,
    producedAt: batch.producedAt,
    importedAt: ctx.now,
    sourceFile: ctx.sourceFile,
    acceptedEntryIds: [...assessments.records, ...comparisons.records].flatMap((r) => (r.importRef ? [r.importRef.entryId] : [])),
    rejected,
    spotCheckSample: batch.evaluator.type === 'ai-reviewer' ? spotCheckSampleSize(assessments.records.length) : 0,
    origin: ctx.origin,
  };
  return { ok: true, batch: record, results: assessments.records, comparisons: comparisons.records, rejected };
}

// ---------------------------------------------------------------------------
// Spot-checking
// ---------------------------------------------------------------------------

const PENDING = 'needs-spot-check';

function requirePending(result: EvaluationResult): void {
  if (result.review.state !== PENDING) throw new LifecycleError(`This assessment is not awaiting a spot-check (it is ${result.review.state})`);
}

export function acceptResult(result: EvaluationResult, by: string, at: string, via: 'individual' | 'batch' = 'individual'): EvaluationResult {
  requirePending(result);
  return { ...result, review: { ...result.review, state: 'accepted', decidedAt: at, decidedBy: by, via } };
}

export function rejectResult(result: EvaluationResult, by: string, note: string, at: string): EvaluationResult {
  requirePending(result);
  return { ...result, review: { ...result.review, state: 'rejected', decidedAt: at, decidedBy: by, via: 'individual', note } };
}

const sameFinding = (a: Finding, b: Finding | undefined): boolean =>
  Boolean(b) &&
  a.outcome === b?.outcome &&
  a.explanation === b.explanation &&
  JSON.stringify(a.rating) === JSON.stringify(b.rating) &&
  JSON.stringify(a.evidenceRefs) === JSON.stringify(b.evidenceRefs);

/**
 * The owner's corrected findings replace the effective findings; the
 * reviewer's originals are kept in `review.originalFindings`. Findings the
 * owner changed are marked `correctedByOwner`. If nothing changed, this is an
 * ordinary acceptance.
 */
export function correctResult(result: EvaluationResult, correctedInput: readonly unknown[], profile: SpecialistProfile, by: string, note: string, at: string): EvaluationResult {
  requirePending(result);
  const corrected = correctedInput.map((f) => FindingSchema.parse(f));
  const problems = findingProblems(corrected, profile);
  if (problems.length) throw new LifecycleError('The corrected findings do not fit the profile', problems);
  const original = new Map(result.findings.map((f) => [f.criterionId, f]));
  const marked = corrected.map((f) => ({ ...f, correctedByOwner: !sameFinding(f, original.get(f.criterionId)) }));
  const changed = marked.some((f) => f.correctedByOwner) || marked.length !== result.findings.length;
  if (!changed) return acceptResult(result, by, at);
  return {
    ...result,
    findings: marked,
    overall: scoreFindings(profile, marked).overall,
    review: { state: 'corrected', decidedAt: at, decidedBy: by, via: 'individual', note, originalFindings: result.findings },
  };
}

export interface BatchProgress {
  readonly total: number;
  readonly pending: number;
  readonly reviewedIndividually: number;
  readonly sampleRequired: number;
  readonly canAcceptRest: boolean;
  readonly pendingComparisons: number;
}

export function batchProgress(batch: ImportBatchRecord, lab: LabSnapshot): BatchProgress {
  const mine = lab.results.filter((r) => r.importRef?.batchId === batch.id);
  const reviewedIndividually = mine.filter((r) => r.review.via === 'individual' && REVIEWED_STATES.has(r.review.state)).length;
  const pending = mine.filter((r) => r.review.state === PENDING).length;
  return {
    total: mine.length,
    pending,
    reviewedIndividually,
    sampleRequired: batch.spotCheckSample,
    canAcceptRest: Boolean(pending) && reviewedIndividually >= batch.spotCheckSample,
    pendingComparisons: lab.comparisons.filter((c) => c.importRef?.batchId === batch.id && c.review.state === PENDING).length,
  };
}

/** Accepts every assessment of the batch still awaiting a spot-check, once the sample has been checked. */
export function acceptRemaining(batch: ImportBatchRecord, lab: LabSnapshot, by: string, at: string): EvaluationResult[] {
  const progress = batchProgress(batch, lab);
  if (!progress.canAcceptRest)
    throw new LifecycleError(`Check at least ${progress.sampleRequired} assessment(s) from this batch one by one first (${progress.reviewedIndividually} done so far)`);
  return lab.results.filter((r) => r.importRef?.batchId === batch.id && r.review.state === PENDING).map((r) => acceptResult(r, by, at, 'batch'));
}
