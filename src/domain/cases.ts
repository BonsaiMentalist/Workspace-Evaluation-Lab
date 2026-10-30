/**
 * Evaluation case lifecycle: Candidate → Validated → Frozen → Evaluated.
 *
 * - Validation checks that the case states everything needed to judge it.
 * - Freezing records a content hash; frozen versions never change again.
 * - Editing a frozen or evaluated case makes a new version (a new candidate);
 *   the old version and every result recorded against it stay as they were.
 */
import type { CaseStatus, EvaluationCase, SpecialistProfile } from './schemas.js';
import { EvaluationCase as EvaluationCaseSchema } from './schemas.js';
import { hashOf, nowIso } from './hash.js';

export class LifecycleError extends Error {
  readonly problems: readonly string[];
  constructor(message: string, problems: readonly string[] = []) {
    super(problems.length ? `${message}: ${problems.join(' ')}` : message);
    this.name = 'LifecycleError';
    this.problems = problems;
  }
}

/** Which status each status may move to through `promote`. */
const NEXT_STATUS = {
  candidate: 'validated',
  validated: 'frozen',
  frozen: 'evaluated',
  evaluated: null,
} as const satisfies Record<CaseStatus, CaseStatus | null>;

const EVALUABLE: ReadonlySet<CaseStatus> = new Set<CaseStatus>(['frozen', 'evaluated']);
const EDITABLE_IN_PLACE: ReadonlySet<CaseStatus> = new Set<CaseStatus>(['candidate', 'validated']);
const OBJECTIVE_KINDS: ReadonlySet<string> = new Set(['objective', 'mixed']);
const AMBIGUOUS = 'ambiguous';

export const STATUS_LABELS = {
  candidate: 'Candidate (draft)',
  validated: 'Validated (checked, not yet frozen)',
  frozen: 'Frozen (fixed test conditions)',
  evaluated: 'Evaluated (frozen and has results)',
} as const satisfies Record<CaseStatus, string>;

/** The fields that define a case's test conditions. Anything that changes these needs a new version. */
export function testConditions(c: EvaluationCase): Record<string, unknown> {
  return {
    id: c.id,
    version: c.version,
    specialistId: c.specialistId,
    profileVersion: c.profileVersion,
    capability: c.capability,
    split: c.split,
    task: c.task,
    context: c.context,
    contextNote: c.contextNote,
    expected: c.expected,
    evidence: c.evidence,
    methods: c.methods,
    checks: c.checks,
    limitations: c.limitations,
    ambiguity: c.ambiguity,
    ambiguityNote: c.ambiguityNote,
  };
}

export const caseContentHash = (c: EvaluationCase): string => hashOf(testConditions(c));

/** Plain-language list of what a case still needs before it can be validated. Empty means ready. */
export function validationProblems(c: EvaluationCase, profile: SpecialistProfile | undefined): string[] {
  const criterionIds = new Set(profile?.criteria.map((cr) => cr.id) ?? []);
  const capabilityIds = new Set(profile?.capabilities.map((cap) => cap.id) ?? []);
  const evidenceIds = new Set(c.evidence.map((e) => e.id));
  const rules: ReadonlyArray<readonly [boolean, string]> = [
    [!profile, `The specialist "${c.specialistId}" has no profile.`],
    [Boolean(profile) && !capabilityIds.has(c.capability), `The capability "${c.capability}" is not part of this specialist's profile.`],
    [!c.task.trim(), 'Describe the task being evaluated.'],
    [!c.context.length && !c.contextNote.trim(), 'List the available context and reference materials, or say in words that there are none.'],
    [!c.expected.behaviour.trim(), 'Describe the expected behaviour.'],
    [!c.expected.acceptanceCriteria.length, 'Add at least one acceptance criterion.'],
    [!c.methods.length, 'Choose at least one evaluation method.'],
    [OBJECTIVE_KINDS.has(c.expected.answerKind) && !c.evidence.length, 'This case has an objective expected answer, so it needs authoritative evidence that supports it.'],
    [!c.limitations.trim(), 'State known limitations and ambiguities (write "None known" if there are none).'],
    [c.ambiguity === AMBIGUOUS && !c.ambiguityNote.trim(), 'Explain what makes this case ambiguous.'],
    [c.context.some((item) => item.kind === 'image' && !item.attachment), 'Every image context item needs an image file.'],
  ];
  const checkProblems = c.checks
    .filter((check) => Boolean(profile) && !criterionIds.has(check.criterionId))
    .map((check) => `Check "${check.id}" refers to criterion "${check.criterionId}", which is not in the profile.`);
  const evidenceProblems = c.checks
    .flatMap((check) => (check.type === 'evidence-reference' ? check.refs : []))
    .filter((ref) => !evidenceIds.has(ref))
    .map((ref) => `A check expects evidence id "${ref}", which the case does not list.`);
  return [...rules.filter(([failed]) => failed).map(([, message]) => message), ...checkProblems, ...evidenceProblems];
}

export function validateCase(c: EvaluationCase, profile: SpecialistProfile | undefined, by: string, notes = '', at = nowIso()): EvaluationCase {
  if (c.status !== 'candidate') throw new LifecycleError(`Only a candidate can be validated; this case is ${c.status}`);
  const problems = validationProblems(c, profile);
  if (problems.length) throw new LifecycleError('This case is not ready to validate', problems);
  // Pin the rubric version, so a validated case never silently follows later profile edits.
  return { ...c, status: NEXT_STATUS.candidate, profileVersion: c.profileVersion ?? profile?.version ?? null, validation: { validatedAt: at, validatedBy: by, notes } };
}

export function freezeCase(c: EvaluationCase, by: string, at = nowIso()): EvaluationCase {
  if (c.status !== 'validated' || !c.validation) throw new LifecycleError('A case must be validated before it can be frozen');
  const frozen: EvaluationCase = { ...c, status: NEXT_STATUS.validated };
  return {
    ...frozen,
    freeze: { frozenAt: at, frozenBy: by, contentHash: caseContentHash(frozen), freezeSetId: c.freeze?.freezeSetId ?? null, freezeSetHash: c.freeze?.freezeSetHash ?? null },
  };
}

/** A frozen case becomes "evaluated" when its first result is recorded. Other statuses are returned unchanged. */
export function markEvaluated(c: EvaluationCase): EvaluationCase {
  return c.status === 'frozen' ? { ...c, status: NEXT_STATUS.frozen } : c;
}

export const canEvaluate = (c: EvaluationCase): boolean => EVALUABLE.has(c.status) && !c.archived;

/** Problems with a case's lifecycle record itself (for example a "frozen" case with no freeze record). */
export function lifecycleProblems(c: EvaluationCase): string[] {
  const validated = c.status !== 'candidate';
  const frozen = EVALUABLE.has(c.status);
  return [
    ...(validated && !c.validation ? [`is marked ${c.status} but has no validation record`] : []),
    ...(frozen && !c.freeze ? [`is marked ${c.status} but has no freeze record`] : []),
    ...(!frozen && c.freeze ? ['has a freeze record but is not frozen'] : []),
    ...(c.freeze && !freezeIntact(c) ? ['no longer matches its freeze hash'] : []),
  ];
}

/** True when a frozen case's stored hash still matches its content (it has not been tampered with). */
export function freezeIntact(c: EvaluationCase): boolean {
  return !c.freeze || c.freeze.contentHash === caseContentHash(c);
}

export type CaseChanges = Partial<Omit<EvaluationCase, 'schema' | 'schemaVersion' | 'id' | 'version' | 'status' | 'validation' | 'freeze' | 'previousVersion' | 'createdAt' | 'provenance'>>;

export interface EditOutcome {
  readonly case: EvaluationCase;
  /** True when the edit produced a new version instead of changing the existing one. */
  readonly newVersion: boolean;
}

/**
 * Applies an edit. Candidates change in place; a validated case changes in
 * place but must be validated again; frozen and evaluated versions are never
 * changed — the edit becomes a new candidate version.
 */
export function editCase(current: EvaluationCase, changes: CaseChanges, latestVersion: number, changeNote: string, at = nowIso()): EditOutcome {
  // An edited case is the owner's own work, even when it started as a synthetic example.
  const merged = EvaluationCaseSchema.parse({ ...current, ...changes, changeNote, provenance: { ...current.provenance, origin: 'user', source: 'manual-entry' } });
  if (EDITABLE_IN_PLACE.has(current.status)) {
    return { case: { ...merged, status: 'candidate', validation: null }, newVersion: false };
  }
  return {
    case: {
      ...merged,
      version: latestVersion + 1,
      status: 'candidate',
      validation: null,
      freeze: null,
      previousVersion: current.version,
      createdAt: at,
    },
    newVersion: true,
  };
}

/**
 * What a model is shown when it is tested on this case: the task and the
 * context only. Expected behaviour, reference answers, evidence notes,
 * checks, limitations and the title are left out, so answers (including
 * held-out answers) never become part of a model's test-time input.
 */
export interface TestInput {
  readonly schema: 'eval-lab/test-input';
  readonly caseId: string;
  readonly caseVersion: number;
  readonly specialistId: string;
  readonly task: string;
  readonly contextNote: string;
  readonly context: ReadonlyArray<{ readonly id: string; readonly title: string; readonly kind: string; readonly text: string; readonly image: string | null }>;
}

export function testInputFor(c: EvaluationCase): TestInput {
  return {
    schema: 'eval-lab/test-input',
    caseId: c.id,
    caseVersion: c.version,
    specialistId: c.specialistId,
    task: c.task,
    contextNote: c.contextNote,
    context: c.context.map((item) => ({ id: item.id, title: item.title, kind: item.kind, text: item.text, image: item.attachment?.name ?? null })),
  };
}
