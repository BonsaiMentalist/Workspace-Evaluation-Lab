/**
 * Executable assessment contract.
 *
 * A local test runner outside the lab (for example, one that runs an
 * engineering output's tests) writes an `eval-lab/executable-report` JSON
 * file. The lab reads that file and turns test outcomes into criterion
 * findings. The lab never runs commands, scripts or code from a report.
 *
 * Mapping rule per criterion: tests whose name starts with the mapping's
 * prefix decide it. Any failed or errored test → fail; every one passed →
 * pass; none ran (or all skipped) → inconclusive. Tests named in
 * `knownFailures` are tracked failures: they are reported, and the result
 * carries `knownFailure`, so they are never confused with a new failure.
 */
import type { EvaluationCase, EvaluationResult, ExecutableReport, Finding, SavedOutput, SpecialistProfile } from '../schemas.js';
import { EvaluationResult as EvaluationResultSchema, ExecutableReport as ExecutableReportSchema, FORMAT_VERSION } from '../schemas.js';
import { canEvaluate, LifecycleError } from '../cases.js';
import { describeZodError, schemaVersionProblem } from '../errors.js';
import { findingProblems } from '../imports.js';
import { scoreFindings } from '../scoring.js';
import { sha256 } from '../hash.js';

const REPORT_SCHEMA = 'eval-lab/executable-report';
const ID_HASH_LENGTH = 20;
const FAILING: ReadonlySet<string> = new Set(['failed', 'error']);

export function parseExecutableReport(raw: unknown): ExecutableReport {
  const problem = schemaVersionProblem(raw, REPORT_SCHEMA, FORMAT_VERSION);
  if (problem) throw new LifecycleError(problem);
  const parsed = ExecutableReportSchema.safeParse(raw, { reportInput: true });
  if (!parsed.success) throw new LifecycleError(`This is not a valid test-runner report. ${describeZodError(parsed.error)}`);
  return parsed.data;
}

function findingFor(report: ExecutableReport, criterionId: string, prefix: string): Finding {
  const tests = report.tests.filter((t) => t.name.startsWith(prefix) && t.status !== 'skipped');
  const known = new Set(report.knownFailures);
  const failing = tests.filter((t) => FAILING.has(t.status));
  const newFailures = failing.filter((t) => !known.has(t.name));
  const knownFailures = failing.filter((t) => known.has(t.name));
  const decided = failing.length ? 'fail' : 'pass';
  const outcome = tests.length ? decided : 'inconclusive';
  const summary = tests.length
    ? `${tests.length - failing.length} of ${tests.length} test(s) passed.`
    : 'No matching tests ran, so this criterion could not be decided.';
  const failureLines = [
    ...newFailures.map((t) => `New failure: ${t.name}${t.message ? ` (${t.message})` : ''}`),
    ...knownFailures.map((t) => `Known, tracked failure: ${t.name}`),
  ];
  return {
    criterionId,
    outcome,
    rating: null,
    explanation: [summary, ...failureLines].join('\n'),
    evidenceRefs: [],
    method: 'executable',
    checkId: null,
    correctedByOwner: false,
  };
}

export function resultFromExecutableReport(
  report: ExecutableReport,
  testCase: EvaluationCase,
  profile: SpecialistProfile,
  output: SavedOutput,
  sourceFile: string | null,
  at: string,
): EvaluationResult {
  if (!canEvaluate(testCase)) throw new LifecycleError('Only frozen, unarchived cases can be evaluated');
  if (report.caseId !== testCase.id || report.caseVersion !== testCase.version || report.outputId !== output.id)
    throw new LifecycleError('The report names a different case, case version or output');
  const findings = report.criterionMapping.map((m) => findingFor(report, m.criterionId, m.testNamePrefix));
  const problems = findingProblems(findings, profile);
  if (problems.length) throw new LifecycleError('The report maps tests to criteria that do not fit the profile', problems);
  const failingKnown = report.tests.filter((t) => FAILING.has(t.status) && report.knownFailures.includes(t.name));
  const allFailuresKnown = failingKnown.length && report.tests.filter((t) => FAILING.has(t.status)).length === failingKnown.length;
  return EvaluationResultSchema.parse({
    schema: 'eval-lab/evaluation-result',
    schemaVersion: FORMAT_VERSION,
    id: `exe-${sha256(`${report.runner.name}:${report.ranAt}:${output.id}`).slice(0, ID_HASH_LENGTH)}`,
    runId: `exe-run-${sha256(`${report.runner.name}:${report.ranAt}`).slice(0, ID_HASH_LENGTH)}`,
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
    methods: ['executable'],
    evaluator: { type: 'executable-runner', name: report.runner.name, version: report.runner.version, date: report.ranAt },
    findings,
    overall: scoreFindings(profile, findings).overall,
    limitations: 'Test results show whether the listed tests passed. They do not show whether the tests themselves are complete or correct.',
    baseline: report.baseline ? { runId: report.baseline.runId, resultId: null, label: report.baseline.label } : null,
    knownFailure: allFailuresKnown ? { reference: failingKnown.map((t) => t.name).join(', '), since: null } : null,
    provenance: { origin: 'user', source: 'runner-import', sourceFile, importedAt: at, note: '' },
    createdAt: at,
  });
}
