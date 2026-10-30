/**
 * Join contract with Workspace Analytics (export format v1.1, `ANALYTICS_EXPORT_SCHEMA_v1.1.md`).
 *
 * Stage 1 implements the contract only: evaluation records carry the join
 * keys, and this module states how they line up with Analytics lines. The
 * lab never reads Analytics files or calls the Analytics app.
 *
 * | Lab field (output / result)        | Analytics field                                  |
 * |------------------------------------|--------------------------------------------------|
 * | `workspace.job`                    | `jobs.jsonl` → `job`                             |
 * | `workspace.piece`                  | `jobs.jsonl` → `piece`                           |
 * | `workspace.phase` (default worker) | `jobs.jsonl` → `phase`                           |
 * | (job, piece, phase)                | `jobs.jsonl` → `id` = `<job>:<piece>:<phase>`    |
 * | `workspace.reply`                  | `replies.jsonl` → `id`; master-check → `reply`   |
 * | `workspace.chat`                   | `replies.jsonl` → `chat`                         |
 * | `model.model` (registry id)        | `model`                                          |
 * | `model.effort`                     | `effort`                                         |
 * | `model.provider` (`claude`/`codex`)| `jobs.jsonl` → `worker`; `replies.jsonl` → `provider` |
 *
 * Unknown keys are `null` on both sides and are never treated as a match.
 */
import { z } from 'zod';
import type { EvaluationResult, SavedOutput } from '../schemas.js';

export interface AnalyticsJoinKeys {
  readonly job: string | null;
  readonly piece: number | null;
  readonly phase: 'worker' | 'review' | 'master-check' | null;
  readonly reply: string | null;
  readonly chat: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly provider: string | null;
}

/** The fields of a `jobs.jsonl` line (Analytics v1.1 §4) that the join reads. Other fields are ignored. */
export const AnalyticsJobLine = z.looseObject({
  v: z.literal(1),
  kind: z.string(),
  id: z.string(),
  at: z.string(),
  job: z.string(),
  piece: z.int(),
  phase: z.enum(['worker', 'review', 'master-check']),
  project: z.string(),
  worker: z.enum(['claude', 'codex']),
  model: z.string(),
  effort: z.string().nullable(),
  reply: z.string().optional(),
  chat: z.string().optional(),
});
export type AnalyticsJobLine = z.infer<typeof AnalyticsJobLine>;

/** The fields of a `replies.jsonl` line (Analytics v1.1 §5) that the join reads. */
export const AnalyticsReplyLine = z.looseObject({
  v: z.literal(1),
  kind: z.string(),
  id: z.string(),
  at: z.string(),
  chat: z.string(),
  specialist: z.string(),
  provider: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
});
export type AnalyticsReplyLine = z.infer<typeof AnalyticsReplyLine>;

const DEFAULT_PHASE = 'worker';

export function joinKeysOf(record: Pick<EvaluationResult, 'workspace' | 'model'> | Pick<SavedOutput, 'workspace' | 'producedBy'>): AnalyticsJoinKeys {
  const model = 'model' in record ? record.model : record.producedBy;
  return {
    job: record.workspace.job,
    piece: record.workspace.piece,
    phase: record.workspace.phase,
    reply: record.workspace.reply,
    chat: record.workspace.chat,
    model: model.model,
    effort: model.effort,
    provider: model.provider,
  };
}

/** The `id` of the matching `jobs.jsonl` line, or null when the job or piece is unknown. */
export function analyticsJobLineId(keys: AnalyticsJoinKeys): string | null {
  if (keys.job === null || keys.piece === null) return null;
  return `${keys.job}:${keys.piece}:${keys.phase ?? DEFAULT_PHASE}`;
}

export interface FieldComparison {
  readonly field: string;
  readonly ours: string | number | null;
  readonly theirs: string | number | null;
  /** null when our side is unknown, so the field could not be compared. */
  readonly same: boolean | null;
}

export interface JoinCheck {
  /** True when the line is the same job piece and every known key agrees. */
  readonly matches: boolean;
  readonly fields: readonly FieldComparison[];
}

const compareField = (field: string, ours: string | number | null, theirs: string | number | null): FieldComparison => ({
  field,
  ours,
  theirs,
  same: ours === null ? null : ours === theirs,
});

export function checkJobLine(keys: AnalyticsJoinKeys, line: AnalyticsJobLine): JoinCheck {
  const fields = [
    compareField('id', analyticsJobLineId(keys), line.id),
    compareField('job', keys.job, line.job),
    compareField('piece', keys.piece, line.piece),
    compareField('phase', keys.phase ?? DEFAULT_PHASE, line.phase),
    compareField('model', keys.model, line.model),
    compareField('effort', keys.effort, line.effort),
    compareField('provider ↔ worker', keys.provider, line.worker),
  ];
  const identityKnown = keys.job !== null && keys.piece !== null;
  return { matches: identityKnown && fields.every((f) => f.same !== false), fields };
}

export function checkReplyLine(keys: AnalyticsJoinKeys, line: AnalyticsReplyLine): JoinCheck {
  const fields = [
    compareField('reply ↔ id', keys.reply, line.id),
    compareField('chat', keys.chat, line.chat),
    compareField('model', keys.model, line.model),
    compareField('effort', keys.effort, line.effort),
    compareField('provider', keys.provider, line.provider),
  ];
  return { matches: keys.reply !== null && fields.every((f) => f.same !== false), fields };
}
