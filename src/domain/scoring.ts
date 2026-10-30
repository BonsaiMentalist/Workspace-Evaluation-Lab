/**
 * Scoring: turns criterion-level findings into a per-capability summary and
 * an overall outcome.
 *
 * Invariants a future edit must keep:
 * - A failed mandatory criterion makes the outcome "critical-failure",
 *   whatever the weighted share says. The weighted share is shown, never used
 *   to decide the outcome.
 * - Optional capabilities (such as literary prose) are summarised on their
 *   own and never change the main outcome.
 * - "Not applicable" findings are left out of the weighted share;
 *   "inconclusive" findings count as not yet known, never as a pass or fail.
 */
import type { Criterion, EvaluationResult, EvaluatorType, Finding, Outcome, OverallStatus, ReviewState, SpecialistProfile } from './schemas.js';

export type OutcomeOrMissing = Outcome | 'not-assessed';

export interface CapabilitySummary {
  readonly capabilityId: string;
  readonly name: string;
  readonly optional: boolean;
  readonly counts: Readonly<Record<OutcomeOrMissing, number>>;
  /** Weighted share of assessed criteria met (pass = 1, partial = ½, fail = 0), or null when nothing was assessed. */
  readonly weightedShare: number | null;
  readonly assessedCount: number;
  readonly criterionCount: number;
}

export interface ScoreSummary {
  readonly overall: OverallStatus;
  readonly criticalFailures: readonly Criterion[];
  readonly coreFailures: readonly Criterion[];
  readonly capabilities: readonly CapabilitySummary[];
  /** Findings that name criteria the profile does not have. They are ignored and listed here. */
  readonly unknownCriterionIds: readonly string[];
  readonly explanation: string;
}

const PARTIAL_CREDIT = 0.5;
const OUTCOME_CREDIT = { pass: 1, partial: PARTIAL_CREDIT, fail: 0, inconclusive: null, 'not-applicable': null } as const satisfies Record<Outcome, number | null>;
const NO_COUNTS: Readonly<Record<OutcomeOrMissing, number>> = { pass: 0, partial: 0, fail: 0, inconclusive: 0, 'not-applicable': 0, 'not-assessed': 0 };

export const OUTCOME_LABELS = {
  pass: 'Passed',
  partial: 'Partly met',
  fail: 'Failed',
  inconclusive: 'Inconclusive',
  'not-applicable': 'Not applicable',
  'not-assessed': 'Not assessed',
} as const satisfies Record<OutcomeOrMissing, string>;

export const OVERALL_LABELS = {
  'critical-failure': 'Critical failure',
  fail: 'Failed',
  'pass-with-issues': 'Passed with issues',
  pass: 'Passed',
  inconclusive: 'Inconclusive',
  incomplete: 'Incomplete',
} as const satisfies Record<OverallStatus, string>;

export const OVERALL_EXPLANATIONS = {
  'critical-failure': 'A mandatory requirement failed. Other strengths do not make up for this.',
  fail: 'At least one core criterion failed.',
  'pass-with-issues': 'No core criterion failed, but some were only partly met or an optional criterion failed.',
  pass: 'Every assessed core criterion passed.',
  inconclusive: 'Some core criteria could not be judged from the evidence, so there is no overall verdict.',
  incomplete: 'Some core criteria have not been assessed yet.',
} as const satisfies Record<OverallStatus, string>;

function summariseCapability(profile: SpecialistProfile, capabilityId: string, byCriterion: ReadonlyMap<string, Finding>): CapabilitySummary {
  const capability = profile.capabilities.find((c) => c.id === capabilityId);
  const criteria = profile.criteria.filter((c) => c.capability === capabilityId);
  const counts = criteria.reduce<Record<OutcomeOrMissing, number>>(
    (acc, criterion) => {
      const key: OutcomeOrMissing = byCriterion.get(criterion.id)?.outcome ?? 'not-assessed';
      return { ...acc, [key]: acc[key] + 1 };
    },
    { ...NO_COUNTS },
  );
  const scored = criteria.flatMap((criterion) => {
    const outcome = byCriterion.get(criterion.id)?.outcome;
    const credit = outcome === undefined ? null : OUTCOME_CREDIT[outcome];
    return credit === null ? [] : [{ weight: criterion.weight, credit }];
  });
  const totalWeight = scored.reduce((sum, s) => sum + s.weight, 0);
  const earned = scored.reduce((sum, s) => sum + s.weight * s.credit, 0);
  return {
    capabilityId,
    name: capability?.name ?? capabilityId,
    optional: capability?.optional ?? false,
    counts,
    weightedShare: totalWeight ? earned / totalWeight : null,
    assessedCount: scored.length,
    criterionCount: criteria.length,
  };
}

/** The latest finding per criterion; a later finding for the same criterion replaces an earlier one. */
function indexFindings(findings: readonly Finding[]): Map<string, Finding> {
  return new Map(findings.map((f) => [f.criterionId, f]));
}

export function scoreFindings(profile: SpecialistProfile, findings: readonly Finding[]): ScoreSummary {
  const knownIds = new Set(profile.criteria.map((c) => c.id));
  const byCriterion = indexFindings(findings.filter((f) => knownIds.has(f.criterionId)));
  const optionalCapabilities = new Set(profile.capabilities.filter((c) => c.optional).map((c) => c.id));
  const mainCriteria = profile.criteria.filter((c) => !optionalCapabilities.has(c.capability));
  const outcomeOf = (c: Criterion): OutcomeOrMissing => byCriterion.get(c.id)?.outcome ?? 'not-assessed';
  const mainCore = mainCriteria.filter((c) => c.tier === 'core');

  const criticalFailures = profile.criteria.filter((c) => c.mandatory && outcomeOf(c) === 'fail');
  const coreFailures = mainCore.filter((c) => !c.mandatory && outcomeOf(c) === 'fail');
  // Ordered: the first rule that applies decides the outcome.
  const rules: ReadonlyArray<readonly [boolean, OverallStatus]> = [
    [Boolean(criticalFailures.length), 'critical-failure'],
    [Boolean(coreFailures.length), 'fail'],
    [mainCore.some((c) => outcomeOf(c) === 'inconclusive'), 'inconclusive'],
    [mainCore.some((c) => outcomeOf(c) === 'not-assessed'), 'incomplete'],
    [mainCriteria.some((c) => outcomeOf(c) === 'partial' || outcomeOf(c) === 'fail'), 'pass-with-issues'],
  ];
  const overall = rules.find(([applies]) => applies)?.[1] ?? 'pass';
  const unknownCriterionIds = [...new Set(findings.map((f) => f.criterionId).filter((id) => !knownIds.has(id)))];

  return {
    overall,
    criticalFailures,
    coreFailures,
    capabilities: profile.capabilities.map((cap) => summariseCapability(profile, cap.id, byCriterion)),
    unknownCriterionIds,
    explanation: OVERALL_EXPLANATIONS[overall],
  };
}

// ---------------------------------------------------------------------------
// Who assessed a result, for reports that must never mix sources silently
// ---------------------------------------------------------------------------

export type AssessedBy = 'person' | 'ai-reviewer' | 'ai-reviewer-corrected' | 'automatic-check' | 'test-runner' | 'ai-judge';

const ASSESSED_BY_TYPE = {
  human: 'person',
  'ai-reviewer': 'ai-reviewer',
  'deterministic-check': 'automatic-check',
  'executable-runner': 'test-runner',
  'ai-judge': 'ai-judge',
} as const satisfies Record<EvaluatorType, AssessedBy>;

export const ASSESSED_BY_LABELS = {
  person: 'Person',
  'ai-reviewer': 'AI reviewer',
  'ai-reviewer-corrected': 'AI reviewer, corrected by owner',
  'automatic-check': 'Automatic check',
  'test-runner': 'Test runner',
  'ai-judge': 'AI judge',
} as const satisfies Record<AssessedBy, string>;

export function assessedBy(result: Pick<EvaluationResult, 'evaluator' | 'review'>): AssessedBy {
  return result.review.state === 'corrected' ? 'ai-reviewer-corrected' : ASSESSED_BY_TYPE[result.evaluator.type];
}

/** Review states whose findings count in reports. Results awaiting spot-check or rejected never count. */
const COUNTING_STATES: ReadonlySet<ReviewState> = new Set<ReviewState>(['not-required', 'accepted', 'corrected']);

export const countsInReports = (result: Pick<EvaluationResult, 'review'>): boolean => COUNTING_STATES.has(result.review.state);

export const REVIEW_STATE_LABELS = {
  'not-required': 'No spot-check needed',
  'needs-spot-check': 'Needs spot-check',
  accepted: 'Accepted by owner',
  corrected: 'Corrected by owner',
  rejected: 'Rejected by owner',
} as const satisfies Record<ReviewState, string>;

const PERCENT = 100;
/** Weighted share as a whole percentage (no false precision), or null when nothing was assessed. */
export const shareAsPercent = (share: number | null): number | null => (share === null ? null : Math.round(share * PERCENT));
