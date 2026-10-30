/**
 * Checks the synthetic starter suite in `fixtures/`.
 *
 * - Every record parses with the zod formats in src/domain/schemas.ts.
 * - Every case targeting validated, frozen or evaluated has no validation problems.
 * - Ids referenced across files exist: profiles and versions, cases, outputs,
 *   criterion ids in findings, evidence ids, candidate cases.
 * - Every image attachment exists with the stated byte size.
 * - The AI reviewer batch has exactly one malformed entry, and its valid
 *   entries only cover outputs without a human result.
 * - Each output's deterministic check outcomes are printed, so good outputs
 *   can be seen to pass and flawed ones to fail.
 *
 * Run with: npx tsx scripts/check-fixtures.ts (exits non-zero on any problem).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { validationProblems } from '../src/domain/cases.js';
import { runCaseChecks } from '../src/domain/checks.js';
import {
  EvaluationCase,
  EvaluationResult,
  ImportedAssessmentBatch,
  ImportedAssessmentEntry,
  ImportedComparisonEntry,
  ProductionObservation,
  SavedOutput,
  SpecialistProfile,
  type AttachmentRef,
  type Finding,
} from '../src/domain/schemas.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const SUITE_DIR = join(FIXTURES, 'suite');
const IMAGES_DIR = join(FIXTURES, 'images');
const BATCH_FILE = join(FIXTURES, 'assessments', 'ai-reviewer-batch.json');
const OBSERVATIONS_FILE = join(FIXTURES, 'observations.json');
const JSON_EXTENSION = '.json';
const EXPECTED_SPECIALISTS = ['master', 'engineering', 'research', 'lore', 'designer', 'trading-analysis', 'trading-psychology'] as const;
const EXPECTED_MALFORMED_ENTRIES = 1;
const MIN_OUTPUTS_PER_FROZEN_CASE = 2;
const NON_PREFERENCES: ReadonlySet<string> = new Set(['tie', 'inconclusive']);
const READY: ReadonlySet<string> = new Set(['validated', 'frozen', 'evaluated']);
const EVALUABLE: ReadonlySet<string> = new Set(['frozen', 'evaluated']);

type Profile = z.infer<typeof SpecialistProfile>;
type Case = z.infer<typeof EvaluationCase>;
type Output = z.infer<typeof SavedOutput>;
type Result = z.infer<typeof EvaluationResult>;

const problems: string[] = [];
const report = (message: string): void => {
  problems.push(message);
};

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const profileKey = (id: string, version: number): string => `${id}@${version}`;

function parseAll<TOut>(schema: z.ZodType<TOut>, items: unknown, where: string): TOut[] {
  if (!Array.isArray(items)) {
    report(`${where}: expected a list`);
    return [];
  }
  return items.flatMap((item, index) => {
    const parsed = schema.safeParse(item);
    if (parsed.success) return [parsed.data];
    report(`${where}[${index}] does not parse:\n${z.prettifyError(parsed.error)}`);
    return [];
  });
}

function fieldOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined; // object checked on this line
}

// ---------------------------------------------------------------------------
// Load the suite
// ---------------------------------------------------------------------------

interface Suite {
  readonly profiles: readonly Profile[];
  readonly cases: readonly Case[];
  readonly outputs: readonly Output[];
  readonly results: readonly Result[];
  readonly fileOf: ReadonlyMap<string, string>;
}

function loadSuite(): Suite {
  const files = readdirSync(SUITE_DIR).filter((name) => name.endsWith(JSON_EXTENSION));
  const specialists = files.map((name) => name.slice(0, -JSON_EXTENSION.length));
  EXPECTED_SPECIALISTS.filter((id) => !specialists.includes(id)).forEach((id) => report(`Missing suite file for "${id}"`));
  const loaded = files.map((name) => {
    const specialist = name.slice(0, -JSON_EXTENSION.length);
    const data = readJson(join(SUITE_DIR, name));
    const cases = parseAll(EvaluationCase, fieldOf(data, 'cases'), `${name} cases`);
    cases.filter((c) => c.specialistId !== specialist).forEach((c) => report(`${name}: case "${c.id}" belongs to "${c.specialistId}"`));
    return {
      name,
      profiles: parseAll(SpecialistProfile, fieldOf(data, 'profiles'), `${name} profiles`),
      cases,
      outputs: parseAll(SavedOutput, fieldOf(data, 'outputs'), `${name} outputs`),
      results: parseAll(EvaluationResult, fieldOf(data, 'results'), `${name} results`),
    };
  });
  const fileOf = new Map(loaded.flatMap((file) => file.cases.map((c) => [c.id, file.name] as const)));
  return {
    profiles: loaded.flatMap((file) => file.profiles),
    cases: loaded.flatMap((file) => file.cases),
    outputs: loaded.flatMap((file) => file.outputs),
    results: loaded.flatMap((file) => file.results),
    fileOf,
  };
}

function checkUnique(kind: string, ids: readonly string[]): void {
  ids.filter((id, index) => ids.indexOf(id) !== index).forEach((id) => report(`Duplicate ${kind} id "${id}"`));
}

function checkAttachment(attachment: AttachmentRef | null, where: string): void {
  if (!attachment) return;
  const path = join(IMAGES_DIR, attachment.name);
  if (!existsSync(path)) {
    report(`${where}: image ${attachment.name} does not exist`);
    return;
  }
  const size = statSync(path).size;
  if (size !== attachment.bytes) report(`${where}: image ${attachment.name} is ${size} bytes, attachment says ${attachment.bytes}`);
}

// ---------------------------------------------------------------------------
// Findings against a profile version and case
// ---------------------------------------------------------------------------

function checkFindings(findings: readonly Finding[], profile: Profile | undefined, testCase: Case, where: string): void {
  if (!profile) {
    report(`${where}: profile version not found`);
    return;
  }
  const criteria = new Map(profile.criteria.map((criterion) => [criterion.id, criterion]));
  const evidenceIds = new Set(testCase.evidence.map((e) => e.id));
  const criterionIds = findings.map((finding) => finding.criterionId);
  checkUnique(`criterion in ${where}`, criterionIds);
  findings.forEach((finding) => {
    const criterion = criteria.get(finding.criterionId);
    if (!criterion) {
      report(`${where}: criterion "${finding.criterionId}" is not in ${profileKey(profile.id, profile.version)}`);
      return;
    }
    finding.evidenceRefs.filter((ref) => !evidenceIds.has(ref)).forEach((ref) => report(`${where}: evidence "${ref}" is not listed by case ${testCase.id}`));
    const scale = criterion.scale;
    if (scale.kind === 'rating' && finding.rating && (finding.rating.min !== scale.min || finding.rating.max !== scale.max)) {
      report(`${where}: rating for "${criterion.id}" does not use the criterion scale ${scale.min}-${scale.max}`);
    }
    if (scale.kind === 'outcome' && finding.rating) report(`${where}: "${criterion.id}" is an outcome criterion but has a rating`);
  });
}

// ---------------------------------------------------------------------------
// Suite cross-references
// ---------------------------------------------------------------------------

function checkSuite(suite: Suite): void {
  const profiles = new Map(suite.profiles.map((p) => [profileKey(p.id, p.version), p]));
  const cases = new Map(suite.cases.map((c) => [c.id, c]));
  const outputs = new Map(suite.outputs.map((o) => [o.id, o]));
  checkUnique('profile', suite.profiles.map((p) => profileKey(p.id, p.version)));
  checkUnique('case', suite.cases.map((c) => c.id));
  checkUnique('output', suite.outputs.map((o) => o.id));
  checkUnique('result', suite.results.map((r) => r.id));

  suite.cases.forEach((c) => {
    const profile = profiles.get(profileKey(c.specialistId, c.profileVersion ?? 1));
    const caseProblems = validationProblems(c, profile);
    if (READY.has(c.status)) caseProblems.forEach((problem) => report(`Case ${c.id} (${c.status}): ${problem}`));
    if (c.validation || c.freeze) report(`Case ${c.id}: validation and freeze must be left null for the seed loader`);
    const contextIds = new Set(c.context.map((item) => item.id));
    c.evidence.filter((e) => e.contextItemId !== null && !contextIds.has(e.contextItemId)).forEach((e) => report(`Case ${c.id}: evidence ${e.id} points at missing context "${e.contextItemId}"`));
    c.context.forEach((item) => checkAttachment(item.attachment, `Case ${c.id} context ${item.id}`));
    const caseOutputs = suite.outputs.filter((o) => o.caseId === c.id);
    if (EVALUABLE.has(c.status) && caseOutputs.length < MIN_OUTPUTS_PER_FROZEN_CASE) report(`Case ${c.id}: frozen cases need at least two outputs`);
    if (!EVALUABLE.has(c.status) && caseOutputs.length) report(`Case ${c.id}: ${c.status} cases must not have outputs`);
    const hasResults = suite.results.some((r) => r.caseId === c.id);
    if (hasResults !== (c.status === 'evaluated')) report(`Case ${c.id}: status "${c.status}" but ${hasResults ? 'has' : 'has no'} results`);
    if (!READY.has(c.status)) console.log(`  candidate ${c.id}: ${caseProblems.length ? caseProblems.join(' ') : 'ready to validate'}`);
  });

  suite.outputs.forEach((o) => {
    const testCase = cases.get(o.caseId);
    if (!testCase || testCase.version !== o.caseVersion) report(`Output ${o.id}: case ${o.caseId} v${o.caseVersion} not found`);
    o.toolArtifacts.forEach((artifact) => checkAttachment(artifact.attachment, `Output ${o.id} artifact ${artifact.id}`));
  });

  suite.results.forEach((r) => {
    const testCase = cases.get(r.caseId);
    const output = outputs.get(r.outputId);
    if (!testCase || !output) {
      report(`Result ${r.id}: case or output not found`);
      return;
    }
    if (output.caseId !== r.caseId) report(`Result ${r.id}: output ${r.outputId} belongs to ${output.caseId}`);
    if (r.profileId !== testCase.specialistId) report(`Result ${r.id}: profile ${r.profileId} does not match case specialist`);
    if (r.split !== testCase.split) report(`Result ${r.id}: split differs from its case`);
    if (JSON.stringify(r.model) !== JSON.stringify(output.producedBy)) report(`Result ${r.id}: model snapshot differs from the output`);
    if (r.overall !== null) report(`Result ${r.id}: leave "overall" out; the loader computes it`);
    checkFindings(r.findings, profiles.get(profileKey(r.profileId, r.profileVersion)), testCase, `Result ${r.id}`);
  });
}

// ---------------------------------------------------------------------------
// AI reviewer batch
// ---------------------------------------------------------------------------

function checkBatch(suite: Suite): void {
  const envelope = ImportedAssessmentBatch.safeParse(readJson(BATCH_FILE));
  if (!envelope.success) {
    report(`Batch envelope does not parse:\n${z.prettifyError(envelope.error)}`);
    return;
  }
  const batch = envelope.data;
  const profiles = new Map(suite.profiles.map((p) => [profileKey(p.id, p.version), p]));
  const cases = new Map(suite.cases.map((c) => [c.id, c]));
  const outputs = new Map(suite.outputs.map((o) => [o.id, o]));
  const scored = new Set(suite.results.map((r) => r.outputId));

  const parsed = batch.assessments.map((raw) => ({ raw, result: ImportedAssessmentEntry.safeParse(raw) }));
  const rejected = parsed.filter((entry) => !entry.result.success);
  rejected.forEach((entry) => console.log(`  rejected as expected: ${String(fieldOf(entry.raw, 'entryId'))} — ${entry.result.error?.issues.map((issue) => issue.message).join('; ')}`));
  if (rejected.length !== EXPECTED_MALFORMED_ENTRIES) report(`Batch: expected exactly ${EXPECTED_MALFORMED_ENTRIES} malformed entry, found ${rejected.length}`);
  const valid = parsed.flatMap((entry) => (entry.result.success ? [entry.result.data] : []));
  checkUnique('batch entry', batch.assessments.map((raw) => String(fieldOf(raw, 'entryId'))));
  console.log(`  ${valid.length} valid assessment entries`);

  valid.forEach((entry) => {
    const where = `Batch entry ${entry.entryId}`;
    const testCase = cases.get(entry.caseId);
    const output = outputs.get(entry.outputId);
    if (!testCase || !output || output.caseId !== entry.caseId) {
      report(`${where}: case/output reference is wrong`);
      return;
    }
    if (!EVALUABLE.has(testCase.status)) report(`${where}: case ${testCase.id} is not frozen`);
    if (scored.has(entry.outputId)) report(`${where}: output ${entry.outputId} already has a human result`);
    const version = entry.profileVersion ?? testCase.profileVersion ?? 1;
    checkFindings(entry.findings, profiles.get(profileKey(testCase.specialistId, version)), testCase, where);
  });

  const comparisons = parseAll(ImportedComparisonEntry, batch.comparisons, 'Batch comparisons');
  comparisons.forEach((comparison) => {
    const where = `Comparison ${comparison.entryId}`;
    const testCase = cases.get(comparison.caseId);
    if (!testCase) {
      report(`${where}: case not found`);
      return;
    }
    comparison.outputIds.filter((id) => outputs.get(id)?.caseId !== comparison.caseId).forEach((id) => report(`${where}: output ${id} is not an output of the case`));
    const choices = [comparison.overall.preferred, ...comparison.perCriterion.map((p) => p.preferred)];
    choices.filter((choice) => !NON_PREFERENCES.has(choice) && !comparison.outputIds.includes(choice)).forEach((choice) => report(`${where}: preferred "${choice}" is not one of its outputs`));
    const profile = profiles.get(profileKey(testCase.specialistId, testCase.profileVersion ?? 1));
    const criterionIds = new Set(profile?.criteria.map((criterion) => criterion.id) ?? []);
    comparison.perCriterion.filter((p) => !criterionIds.has(p.criterionId)).forEach((p) => report(`${where}: unknown criterion ${p.criterionId}`));
  });
  console.log(`  ${comparisons.length} valid comparison entries`);
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

function checkObservations(suite: Suite): void {
  const observations = parseAll(ProductionObservation, readJson(OBSERVATIONS_FILE), 'observations.json');
  checkUnique('observation', observations.map((o) => o.id));
  const cases = new Map(suite.cases.map((c) => [c.id, c]));
  const specialists = new Set(suite.profiles.map((p) => p.id));
  observations.forEach((o) => {
    if (o.specialistId && !specialists.has(o.specialistId)) report(`Observation ${o.id}: unknown specialist ${o.specialistId}`);
    if (o.candidateCaseId && cases.get(o.candidateCaseId)?.status !== 'candidate') report(`Observation ${o.id}: ${o.candidateCaseId} is not a candidate case`);
  });
  console.log(`  ${observations.length} observations`);
}

// ---------------------------------------------------------------------------
// Deterministic check outcomes per output
// ---------------------------------------------------------------------------

function printCheckOutcomes(suite: Suite): void {
  const cases = new Map(suite.cases.map((c) => [c.id, c]));
  suite.outputs.forEach((output) => {
    const testCase = cases.get(output.caseId);
    if (!testCase || !testCase.checks.length) return;
    const run = runCaseChecks(testCase, output);
    const passed = run.outcomes.filter((o) => o.passed).length;
    console.log(`  ${output.id} [${output.label}] ${passed}/${run.outcomes.length} checks passed`);
    run.outcomes.forEach((o) => console.log(`      ${o.passed ? 'PASS' : 'FAIL'} ${o.checkId} (${o.criterionId}): ${o.detail}`));
  });
}

// ---------------------------------------------------------------------------

function summarise(suite: Suite): void {
  const byStatus = suite.cases.reduce<Record<string, number>>((counts, c) => ({ ...counts, [c.status]: (counts[c.status] ?? 0) + 1 }), {});
  const scored = new Set(suite.results.map((r) => r.outputId));
  console.log(
    `  ${suite.profiles.length} profiles, ${suite.cases.length} cases (${Object.entries(byStatus)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ')}), ${suite.outputs.length} outputs (${suite.outputs.filter((o) => !scored.has(o.id)).length} unscored), ${suite.results.length} results`,
  );
  console.log(
    `  ambiguous: ${suite.cases.filter((c) => c.ambiguity === 'ambiguous').length}, held-out: ${suite.cases.filter((c) => c.split === 'held-out').length}`,
  );
}

console.log('Suite');
const suite = loadSuite();
checkSuite(suite);
summarise(suite);
console.log('AI reviewer batch');
checkBatch(suite);
console.log('Observations');
checkObservations(suite);
console.log('Deterministic checks per output');
printCheckOutcomes(suite);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('\nAll fixtures are valid.');
}
