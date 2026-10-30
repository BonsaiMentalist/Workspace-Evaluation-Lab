/** Building evaluation results from manual scoring and from deterministic checks. */
import type { EvaluationCase, EvaluationResult, Evaluator, Origin, SavedOutput, SpecialistProfile } from './schemas.js';
import { EvaluationResult as EvaluationResultSchema, Finding as FindingSchema, FORMAT_VERSION } from './schemas.js';
import { canEvaluate, LifecycleError } from './cases.js';
import { CHECK_ENGINE_NAME, CHECK_ENGINE_VERSION, runCaseChecks } from './checks.js';
import { findingProblems } from './imports.js';
import { scoreFindings } from './scoring.js';
import { newId, nowIso, sha256 } from './hash.js';

const CHECK_ID_LENGTH = 24;

export interface ResultNotes {
  readonly overallNote?: string;
  readonly uncertainty?: string;
  readonly exclusions?: string;
  readonly limitations?: string;
}

function requireEvaluable(testCase: EvaluationCase, output: SavedOutput): void {
  if (!canEvaluate(testCase)) throw new LifecycleError('Only frozen, unarchived cases can be evaluated. Validate and freeze the case first');
  if (output.caseId !== testCase.id || output.caseVersion !== testCase.version) throw new LifecycleError('This output belongs to a different case or case version');
}

function baseResult(testCase: EvaluationCase, profile: SpecialistProfile, output: SavedOutput, origin: Origin, at: string): Omit<EvaluationResult, 'id' | 'runId' | 'methods' | 'evaluator' | 'findings' | 'overall'> {
  return {
    schema: 'eval-lab/evaluation-result',
    schemaVersion: FORMAT_VERSION,
    caseId: testCase.id,
    caseVersion: testCase.version,
    split: testCase.split,
    profileId: profile.id,
    profileVersion: profile.version,
    outputId: output.id,
    model: output.producedBy,
    configuration: output.configuration,
    workspace: output.workspace,
    resources: output.resources,
    overallNote: '',
    uncertainty: '',
    exclusions: '',
    limitations: '',
    review: { state: 'not-required', decidedAt: null, decidedBy: null, via: null, note: '', originalFindings: null },
    baseline: null,
    knownFailure: null,
    importRef: null,
    provenance: { origin, source: 'manual-entry', sourceFile: null, importedAt: null, note: '' },
    createdAt: at,
  };
}

/** A person's criterion-by-criterion assessment, entered in the lab. */
export function manualResult(
  testCase: EvaluationCase,
  profile: SpecialistProfile,
  output: SavedOutput,
  findingsInput: readonly unknown[],
  evaluatorName: string,
  notes: ResultNotes,
  origin: Origin = 'user',
  at = nowIso(),
): EvaluationResult {
  requireEvaluable(testCase, output);
  const findings = findingsInput.map((f) => FindingSchema.parse(f));
  if (!findings.length) throw new LifecycleError('Assess at least one criterion before saving');
  const problems = findingProblems(findings, profile);
  if (problems.length) throw new LifecycleError('Some findings do not fit the profile', problems);
  const evaluator: Evaluator = { type: 'human', name: evaluatorName, version: null, date: at };
  return EvaluationResultSchema.parse({
    ...baseResult(testCase, profile, output, origin, at),
    ...notes,
    id: newId('res'),
    runId: newId('run'),
    methods: ['manual'],
    evaluator,
    findings,
    overall: scoreFindings(profile, findings).overall,
  });
}

/**
 * Runs the case's deterministic checks on an output. The result id comes from
 * the run's fingerprint, so running the same checks on the same output again
 * gives the identical result instead of a second copy.
 */
export function checkResult(testCase: EvaluationCase, profile: SpecialistProfile, output: SavedOutput, origin: Origin = 'user', at = nowIso()): EvaluationResult {
  requireEvaluable(testCase, output);
  if (!testCase.checks.length) throw new LifecycleError('This case has no automatic checks');
  const run = runCaseChecks(testCase, output);
  const id = `chk-${sha256(`${run.fingerprint}:${output.id}`).slice(0, CHECK_ID_LENGTH)}`;
  return EvaluationResultSchema.parse({
    ...baseResult(testCase, profile, output, origin, at),
    id,
    runId: `checks-${run.fingerprint.slice(0, CHECK_ID_LENGTH)}`,
    methods: ['deterministic'],
    evaluator: { type: 'deterministic-check', name: CHECK_ENGINE_NAME, version: CHECK_ENGINE_VERSION, date: null },
    findings: run.findings,
    overall: scoreFindings(profile, run.findings).overall,
    limitations: 'Automatic checks only test wording, labels, structure, citations and length. They cannot judge whether the content is correct or well reasoned. Criteria without checks are left unassessed.',
  });
}
