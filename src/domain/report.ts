/**
 * Comparison reports for outputs of the same case, and the History view.
 *
 * Invariants a future edit must keep:
 * - Findings from different kinds of evaluator (person, AI reviewer, check…)
 *   are never merged into one verdict. A criterion is only said to favour an
 *   output when one kind of evaluator assessed every output on it.
 * - Every comparison states whether its conditions were equivalent,
 *   partially equivalent or not directly comparable, and why.
 * - Counts are shown as counts. No percentages or confidence figures are
 *   made from a handful of observations.
 */
import type { Criterion, EvaluationCase, EvaluationResult, Finding, Outcome, SavedOutput, SpecialistProfile } from './schemas.js';
import { ASSESSED_BY_LABELS, assessedBy, countsInReports, type AssessedBy } from './scoring.js';
import { findProfile, latestCase, type LabSnapshot } from './lookup.js';

export type Equivalence = 'equivalent' | 'partially-equivalent' | 'not-comparable';

export const EQUIVALENCE_LABELS = {
  equivalent: 'Equivalent conditions',
  'partially-equivalent': 'Partially equivalent conditions',
  'not-comparable': 'Not directly comparable',
} as const satisfies Record<Equivalence, string>;

export interface EquivalenceReport {
  readonly level: Equivalence;
  readonly reasons: readonly string[];
  /** What differs between the outputs being compared (the things under test). */
  readonly differences: readonly string[];
}

interface SetupVariable {
  readonly name: string;
  readonly read: (o: SavedOutput) => string | null;
}

const SETUP_VARIABLES: readonly SetupVariable[] = [
  { name: 'model', read: (o) => o.producedBy.model },
  { name: 'effort level', read: (o) => o.producedBy.effort },
  { name: 'specialist configuration', read: (o) => o.configuration.configurationId ?? o.configuration.fingerprint },
  { name: 'context configuration', read: (o) => o.configuration.contextConfigId },
  { name: 'tools', read: (o) => (o.configuration.toolConfigIds.length ? [...o.configuration.toolConfigIds].sort().join(',') : null) },
];

/** More than one setup difference means a difference in results can't be pinned on one of them. */
const MAX_CLEAN_DIFFERENCES = 1;

export function equivalenceOf(outputs: readonly SavedOutput[], results: readonly EvaluationResult[]): EquivalenceReport {
  const caseIds = new Set(outputs.map((o) => o.caseId));
  if (caseIds.size > 1) return { level: 'not-comparable', reasons: ['The outputs answer different cases.'], differences: [] };
  const caseVersions = new Set(outputs.map((o) => o.caseVersion));
  const profileVersions = new Set(results.map((r) => `${r.profileId} v${r.profileVersion}`));
  const evaluatorKinds = new Set(results.map((r) => assessedBy(r)));

  const differences = SETUP_VARIABLES.filter((v) => new Set(outputs.map(v.read)).size > 1).map((v) => v.name);
  const unknown = SETUP_VARIABLES.filter((v) => outputs.some((o) => v.read(o) === null) && outputs.some((o) => v.read(o) !== null)).map((v) => v.name);

  const reasons = [
    ...(caseVersions.size > 1 ? ['The outputs answer different versions of the case, so the test conditions changed.'] : []),
    ...(profileVersions.size > 1 ? [`The assessments used different rubric versions (${[...profileVersions].join(', ')}).`] : []),
    ...(evaluatorKinds.size > 1 ? [`Different kinds of evaluator were involved (${[...evaluatorKinds].map((k) => ASSESSED_BY_LABELS[k]).join(', ')}); their findings are shown separately.`] : []),
    ...(differences.length > MAX_CLEAN_DIFFERENCES ? [`More than one thing differs (${differences.join(', ')}), so a difference in results cannot be pinned on any one of them.`] : []),
    ...(unknown.length ? [`Not recorded for every output: ${unknown.join(', ')}.`] : []),
  ];
  const level: Equivalence = reasons.length ? 'partially-equivalent' : 'equivalent';
  const clean = differences.length
    ? `Only the ${differences[0]} differs, so this is a like-for-like comparison of that one thing.`
    : 'The recorded setup is identical; differences reflect run-to-run variation.';
  return { level, reasons: reasons.length ? reasons : [clean], differences };
}

// ---------------------------------------------------------------------------
// Criterion-level comparison
// ---------------------------------------------------------------------------

export type Significance = 'major' | 'minor' | 'none' | 'unknown';

export interface CellFinding {
  readonly resultId: string;
  readonly source: AssessedBy;
  readonly finding: Finding;
}

export interface CriterionRow {
  readonly criterion: Criterion;
  readonly cells: ReadonlyArray<{ readonly outputId: string; readonly findings: readonly CellFinding[] }>;
  /** Output ids favoured on this criterion, "tie", or "unclear" when no single evaluator kind covers every output. */
  readonly favours: readonly string[] | 'tie' | 'unclear';
  readonly basis: AssessedBy | null;
  readonly significance: Significance;
  readonly note: string;
}

export interface ComparisonReport {
  readonly equivalence: EquivalenceReport;
  readonly rows: readonly CriterionRow[];
  readonly favouredCounts: Readonly<Record<string, number>>;
  readonly uncertain: readonly string[];
  readonly enoughObservations: { readonly enough: boolean; readonly message: string };
  readonly furtherExperiment: { readonly justified: 'yes' | 'no' | 'improve-case-first'; readonly message: string };
}

const PASS_RANK = 2;
const OUTCOME_RANK = { pass: PASS_RANK, partial: 1, fail: 0, inconclusive: null, 'not-applicable': null } as const satisfies Record<Outcome, number | null>;
const MAJOR_RANK_GAP = PASS_RANK;
const MAJOR_RATING_SHARE = 0.4;
/** Kinds of evaluator tried, in this order, as the basis for saying which output a criterion favours. */
const BASIS_ORDER: readonly AssessedBy[] = ['person', 'ai-reviewer-corrected', 'ai-reviewer', 'test-runner', 'automatic-check'];
const MIN_CASES_FOR_PATTERN = 5;

function scoreOf(finding: Finding): number | null {
  if (finding.rating) return (finding.rating.value - finding.rating.min) / (finding.rating.max - finding.rating.min);
  const rank = OUTCOME_RANK[finding.outcome];
  return rank === null ? null : rank / MAJOR_RANK_GAP;
}

function compareCriterion(criterion: Criterion, outputIds: readonly string[], results: readonly EvaluationResult[]): CriterionRow {
  const cells = outputIds.map((outputId) => ({
    outputId,
    findings: results
      .filter((r) => r.outputId === outputId)
      .flatMap((r) => r.findings.filter((f) => f.criterionId === criterion.id).map((finding) => ({ resultId: r.id, source: assessedBy(r), finding }))),
  }));
  const basis = BASIS_ORDER.find((kind) => cells.every((cell) => cell.findings.some((f) => f.source === kind))) ?? null;
  if (!basis) {
    const anyFindings = cells.some((c) => c.findings.length);
    return {
      criterion,
      cells,
      favours: 'unclear',
      basis: null,
      significance: 'unknown',
      note: anyFindings ? 'Not every output was assessed on this by the same kind of evaluator, so they are not compared.' : 'Not assessed yet.',
    };
  }
  // The most recent finding of the basis kind represents each output.
  const scores = cells.map((cell) => {
    const finding = cell.findings.filter((f) => f.source === basis).at(-1)?.finding;
    return { outputId: cell.outputId, finding, score: finding ? scoreOf(finding) : null };
  });
  if (scores.every((s) => s.finding?.outcome === 'not-applicable')) {
    return { criterion, cells, favours: 'tie', basis, significance: 'none', note: 'Not applicable to this case.' };
  }
  if (scores.some((s) => s.score === null)) {
    return { criterion, cells, favours: 'unclear', basis, significance: 'unknown', note: 'At least one output was inconclusive or not applicable here.' };
  }
  const values = scores.map((s) => s.score ?? 0);
  const best = Math.max(...values);
  const gap = best - Math.min(...values);
  if (!gap) return { criterion, cells, favours: 'tie', basis, significance: 'none', note: 'No difference.' };
  const passFailSplit = scores.some((s) => s.finding?.outcome === 'fail') && scores.some((s) => s.finding?.outcome === 'pass');
  const mandatorySplit = criterion.mandatory && scores.some((s) => s.finding?.outcome === 'fail');
  // The rating gap only counts when every output has a rating; "passed" versus "partly met" alone is a minor difference.
  const ratedEverywhere = scores.every((s) => s.finding?.rating);
  const major = passFailSplit || mandatorySplit || (ratedEverywhere && gap >= MAJOR_RATING_SHARE);
  return {
    criterion,
    cells,
    favours: scores.filter((s) => s.score === best).map((s) => s.outputId),
    basis,
    significance: major ? 'major' : 'minor',
    note: mandatorySplit ? 'A mandatory requirement failed for at least one output.' : '',
  };
}

export function compareOutputs(profile: SpecialistProfile, outputs: readonly SavedOutput[], allResults: readonly EvaluationResult[]): ComparisonReport {
  const outputIds = outputs.map((o) => o.id);
  const results = allResults.filter((r) => outputIds.includes(r.outputId) && countsInReports(r));
  const rows = profile.criteria.map((criterion) => compareCriterion(criterion, outputIds, results));
  const favouredCounts = Object.fromEntries(
    outputIds.map((id) => [id, rows.filter((r) => Array.isArray(r.favours) && r.favours.length === 1 && r.favours[0] === id).length]),
  );
  const unclear = rows.filter((r) => r.favours === 'unclear');
  const majorCore = rows.filter((r) => r.significance === 'major' && r.criterion.tier === 'core');
  const pendingSpotChecks = allResults.filter((r) => outputIds.includes(r.outputId) && r.review.state === 'needs-spot-check').length;

  const uncertain = [
    ...(unclear.length ? [`${unclear.length} of ${rows.length} criteria could not be compared (not assessed, inconclusive, or assessed by different kinds of evaluator).`] : []),
    ...(pendingSpotChecks ? [`${pendingSpotChecks} imported assessment(s) still await your spot-check and are not counted.`] : []),
    ...(results.length < outputs.length ? ['At least one output has no counted assessment.'] : []),
  ];
  const assessedRows = rows.length - unclear.length;
  // Ordered: the first verdict whose condition holds is given. A practically significant core difference
  // is worth following up even when other criteria could not be compared.
  const verdicts: ReadonlyArray<readonly [boolean, ComparisonReport['furtherExperiment']]> = [
    [
      Boolean(majorCore.length),
      { justified: 'yes', message: `There are practically significant differences on ${majorCore.length} core criterion(s). Worth repeating on more cases of this kind before drawing a conclusion.` },
    ],
    [
      unclear.length > assessedRows,
      { justified: 'improve-case-first', message: 'Most criteria could not be compared. Assess the outputs (or improve the case or rubric) before planning an experiment.' },
    ],
  ];
  const furtherExperiment = verdicts.find(([holds]) => holds)?.[1] ?? {
    justified: 'no' as const,
    message: 'No practically significant difference on core criteria. A dedicated experiment is probably not justified by this case alone.',
  };

  return {
    equivalence: equivalenceOf(outputs, results),
    rows,
    favouredCounts,
    uncertain,
    enoughObservations: {
      enough: false,
      message: 'This is one case. A single case can show a difference, but it cannot establish a general strength or weakness of a model or configuration.',
    },
    furtherExperiment,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryRow {
  readonly result: EvaluationResult;
  readonly specialistId: string;
  readonly caseTitle: string;
  readonly source: AssessedBy;
  readonly warnings: readonly string[];
}

export interface HistoryGroup {
  readonly key: string;
  readonly specialistId: string;
  readonly model: string | null;
  readonly configurationId: string | null;
  readonly results: number;
  readonly cases: number;
  readonly outcomeCounts: Readonly<Record<string, number>>;
  readonly sources: readonly AssessedBy[];
  readonly warnings: readonly string[];
  readonly enough: boolean;
}

function rowWarnings(result: EvaluationResult, lab: LabSnapshot): string[] {
  const latest = latestCase(lab, result.caseId);
  const profile = findProfile(lab, result.profileId, result.profileVersion);
  const newestProfile = Math.max(...lab.profiles.filter((p) => p.id === result.profileId).map((p) => p.version));
  return [
    ...(latest && latest.version !== result.caseVersion ? [`Case is now at version ${latest.version}; this result is for version ${result.caseVersion}.`] : []),
    ...(profile && newestProfile > result.profileVersion ? [`Rubric is now at version ${newestProfile}; this result used version ${result.profileVersion}.`] : []),
    ...(result.split === 'held-out' ? ['Held-out case: keep apart from tuning decisions.'] : []),
    ...(result.knownFailure ? [`Known, tracked failure (${result.knownFailure.reference}).`] : []),
  ];
}

export function historyRows(lab: LabSnapshot): HistoryRow[] {
  const cases = new Map(lab.cases.map((c) => [`${c.id}@${c.version}`, c]));
  return lab.results.filter(countsInReports).map((result) => {
    const c: EvaluationCase | undefined = cases.get(`${result.caseId}@${result.caseVersion}`);
    return { result, specialistId: result.profileId, caseTitle: c?.title ?? result.caseId, source: assessedBy(result), warnings: rowWarnings(result, lab) };
  });
}

/** Results grouped by specialist, model and configuration, with warnings where the group mixes conditions. */
export function historyGroups(rows: readonly HistoryRow[]): HistoryGroup[] {
  const keyOf = (row: HistoryRow): string => `${row.specialistId}|${row.result.model.model ?? '?'}|${row.result.configuration.configurationId ?? '?'}`;
  const keys = [...new Set(rows.map(keyOf))];
  return keys.map((key) => {
    const mine = rows.filter((row) => keyOf(row) === key);
    const first = mine[0];
    const profileVersions = new Set(mine.map((r) => r.result.profileVersion));
    const sources = [...new Set(mine.map((r) => r.source))];
    const splits = new Set(mine.map((r) => r.result.split));
    const cases = new Set(mine.map((r) => r.result.caseId)).size;
    const outcomeCounts = mine.reduce<Record<string, number>>((acc, r) => {
      const outcome = r.result.overall ?? 'incomplete';
      return { ...acc, [outcome]: (acc[outcome] ?? 0) + 1 };
    }, {});
    const warnings = [
      ...(profileVersions.size > 1 ? [`Mixes rubric versions ${[...profileVersions].sort().join(', ')}.`] : []),
      ...(sources.length > 1 ? [`Mixes evaluators (${sources.map((s) => ASSESSED_BY_LABELS[s]).join(', ')}); read each row's source.`] : []),
      ...(splits.size > 1 ? ['Mixes held-out and development cases.'] : []),
      ...(cases < MIN_CASES_FOR_PATTERN ? [`Only ${cases} case(s): too few to see a pattern.`] : []),
    ];
    return {
      key,
      specialistId: first?.specialistId ?? '',
      model: first?.result.model.model ?? null,
      configurationId: first?.result.configuration.configurationId ?? null,
      results: mine.length,
      cases,
      outcomeCounts,
      sources,
      warnings,
      enough: cases >= MIN_CASES_FOR_PATTERN,
    };
  });
}
