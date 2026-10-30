/**
 * Future extension point: automated AI judging called by the lab itself.
 *
 * Not implemented in Stage 1. The lab makes no AI calls, downloads no models
 * and runs no inference. This interface fixes the shape a later judge must
 * return so its output flows through the same path as imported assessments:
 * evaluator type `ai-judge`, review state "needs spot-check", findings kept
 * per criterion, and the judge's identity and configuration recorded.
 */
import type { TestInput } from '../cases.js';
import type { Criterion, ImportedAssessmentEntry } from '../schemas.js';

export interface JudgeRequest {
  readonly testInput: TestInput;
  /** The rubric the judge applies. Expected answers are passed only when the case is not held-out. */
  readonly criteria: readonly Criterion[];
  readonly expectedBehaviour: string | null;
  readonly outputText: string;
}

export interface JudgeIdentity {
  readonly name: string;
  readonly model: string;
  readonly configurationId: string;
}

export interface AutomatedJudge {
  readonly identity: JudgeIdentity;
  /** Must not be called in Stage 1. A later stage wires this behind an explicit, opt-in setting. */
  assess(request: JudgeRequest): Promise<Pick<ImportedAssessmentEntry, 'findings' | 'overallNote' | 'uncertainty' | 'limitations'>>;
}

/** Stage 1 ships with no judges. */
export const AVAILABLE_JUDGES: readonly AutomatedJudge[] = [];
