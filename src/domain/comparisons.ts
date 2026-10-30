/**
 * Blinded comparisons: two or more saved outputs for the same case, shown
 * as "Output A", "Output B"… with every identifying field removed until a
 * preference (or a tie, or "inconclusive") is recorded with a reason.
 *
 * The blind view is built from an allow-list of fields, so a field added to
 * outputs later stays hidden unless it is added here on purpose.
 */
import type { BlindedComparison, BlindLabel, Choice, Evaluator, Preference, SavedOutput } from './schemas.js';
import { BLIND_LABELS, BlindedComparison as BlindedComparisonSchema, Preference as PreferenceSchema } from './schemas.js';
import { sha256, nowIso } from './hash.js';
import { LifecycleError } from './cases.js';

export interface BlindEntry {
  readonly label: BlindLabel;
  readonly text: string;
  readonly artifacts: ReadonlyArray<{ readonly kind: 'image' | 'text'; readonly text: string; readonly image: { readonly store: 'fixture' | 'local'; readonly name: string; readonly alt: string } | null }>;
}

export interface BlindView {
  readonly comparisonId: string;
  readonly caseId: string;
  readonly caseVersion: number;
  readonly criterionIds: readonly string[];
  readonly entries: readonly BlindEntry[];
}

export const CHOICE_LABELS = { tie: 'A tie', inconclusive: 'Inconclusive' } as const;

/** Assigns A, B, C… in an order fixed by the seed but unrelated to the order outputs were given in. */
export function assignBlindLabels(outputIds: readonly string[], seed: string): Array<{ label: BlindLabel; outputId: string }> {
  if (outputIds.length > BLIND_LABELS.length) throw new LifecycleError(`A comparison can include at most ${BLIND_LABELS.length} outputs`);
  return [...outputIds]
    .map((outputId) => ({ outputId, key: sha256(`${seed}:${outputId}`) }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ outputId }, index) => ({ label: BLIND_LABELS[index] ?? BLIND_LABELS[0], outputId }));
}

export const isRevealed = (c: BlindedComparison): boolean => c.status === 'recorded';

export function blindView(c: BlindedComparison, outputs: readonly SavedOutput[]): BlindView {
  const byId = new Map(outputs.map((o) => [o.id, o]));
  return {
    comparisonId: c.id,
    caseId: c.caseId,
    caseVersion: c.caseVersion,
    criterionIds: c.criterionIds,
    entries: c.entries.map(({ label, outputId }) => {
      const output = byId.get(outputId);
      return {
        label,
        text: output?.text ?? '',
        artifacts: (output?.toolArtifacts ?? []).map((a) => ({
          kind: a.kind,
          text: a.text,
          image: a.attachment ? { store: a.attachment.store, name: a.attachment.name, alt: a.attachment.alt } : null,
        })),
      };
    }),
  };
}

export function outputIdForLabel(c: BlindedComparison, choice: Choice): string | null {
  return c.entries.find((e) => e.label === choice)?.outputId ?? null;
}

function checkChoices(c: BlindedComparison, preference: Preference): void {
  const labels = new Set<string>(c.entries.map((e) => e.label));
  const allowed = (choice: Choice): boolean => labels.has(choice) || choice === 'tie' || choice === 'inconclusive';
  const bad = [preference.overall.choice, ...preference.perCriterion.map((p) => p.choice)].filter((choice) => !allowed(choice));
  if (bad.length) throw new LifecycleError(`Choices must be one of the outputs shown, "tie" or "inconclusive"; got ${bad.join(', ')}`);
  const unknown = preference.perCriterion.map((p) => p.criterionId).filter((id) => c.criterionIds.length && !c.criterionIds.includes(id));
  if (unknown.length) throw new LifecycleError(`These criteria are not part of this comparison: ${unknown.join(', ')}`);
}

export interface NewComparison {
  readonly id: string;
  readonly caseId: string;
  readonly caseVersion: number;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly outputIds: readonly string[];
  readonly criterionIds: readonly string[];
  readonly provenance: BlindedComparison['provenance'];
}

export function createComparison(input: NewComparison, at = nowIso()): BlindedComparison {
  return BlindedComparisonSchema.parse({
    schema: 'eval-lab/blinded-comparison',
    schemaVersion: 1,
    id: input.id,
    caseId: input.caseId,
    caseVersion: input.caseVersion,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    entries: assignBlindLabels(input.outputIds, input.id),
    criterionIds: input.criterionIds,
    status: 'open',
    provenance: input.provenance,
    createdAt: at,
  });
}

/** The owner (or another person) records a preference. This is what reveals the identities. */
export function recordPreference(c: BlindedComparison, preferenceInput: unknown, evaluator: Evaluator, at = nowIso()): BlindedComparison {
  if (c.status === 'recorded') throw new LifecycleError('A preference has already been recorded for this comparison');
  const preference = PreferenceSchema.parse(preferenceInput);
  checkChoices(c, preference);
  const imported = c.importedPreference !== null;
  return {
    ...c,
    status: 'recorded',
    preference,
    // An imported comparison keeps the outside reviewer as its evaluator; the owner's own choice is recorded as a correction.
    evaluator: imported ? c.evaluator : evaluator,
    review: imported ? { ...c.review, state: 'corrected', decidedAt: at, decidedBy: evaluator.name, via: 'individual' } : c.review,
    recordedAt: at,
  };
}

/** The owner accepts an imported reviewer's preference after looking at the blinded outputs. */
export function acceptImportedPreference(c: BlindedComparison, by: string, at = nowIso()): BlindedComparison {
  if (!c.importedPreference) throw new LifecycleError('This comparison has no imported preference to accept');
  if (c.status === 'recorded') throw new LifecycleError('A preference has already been recorded for this comparison');
  return { ...c, status: 'recorded', preference: c.importedPreference, review: { ...c.review, state: 'accepted', decidedAt: at, decidedBy: by, via: 'individual' }, recordedAt: at };
}

/** The owner rejects an imported preference. Identities stay hidden; the owner may still record their own. */
export function rejectImportedPreference(c: BlindedComparison, by: string, note: string, at = nowIso()): BlindedComparison {
  if (!c.importedPreference) throw new LifecycleError('This comparison has no imported preference to reject');
  if (c.status === 'recorded') throw new LifecycleError('A preference has already been recorded for this comparison, so the imported one can no longer be rejected');
  return { ...c, review: { ...c.review, state: 'rejected', decidedAt: at, decidedBy: by, via: 'individual', note } };
}

/** Which output (if any) the recorded overall preference picked. */
export function preferredOutputId(c: BlindedComparison): string | 'tie' | 'inconclusive' | null {
  const choice = c.preference?.overall.choice;
  if (!choice) return null;
  if (choice === 'tie' || choice === 'inconclusive') return choice;
  return outputIdForLabel(c, choice);
}
