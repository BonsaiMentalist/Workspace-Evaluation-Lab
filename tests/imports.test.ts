/* eslint-disable ts-patterns/no-magic-numbers -- entry counts read more clearly as literals in tests */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptRemaining, acceptResult, batchProgress, correctResult, importAssessmentBatch, rejectResult } from '../src/domain/imports.js';
import { findBatch, findProfile } from '../src/domain/lookup.js';
import { countsInReports } from '../src/domain/scoring.js';
import { historyRows } from '../src/domain/report.js';
import { FIXTURES_DIR } from '../src/paths.js';
import type { LabStore } from '../src/storage/store.js';
import { freshStore } from './helpers.js';

const AT = '2026-10-25T12:00:00Z';
const BATCH_ID = 'batch-synthetic-ai-review-001';
const batchFile = (): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES_DIR, 'assessments', 'ai-reviewer-batch.json'), 'utf8')) as Record<string, unknown>;

async function storeWithoutBatch(): Promise<LabStore> {
  const store = await freshStore();
  // The seeded lab already holds the synthetic batch; tests import it fresh under a new batch id.
  return store;
}

const ctx = (store: LabStore) => ({ lab: store.snapshot(), sourceFile: 'review.json', now: AT, origin: 'user' as const });

describe('importing outside assessments', () => {
  it('keeps the evaluator identity and source file, and starts AI assessments as "needs spot-check"', async () => {
    const store = await storeWithoutBatch();
    const outcome = importAssessmentBatch({ ...batchFile(), batchId: 'batch-copy' }, ctx(store));
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.results).toHaveLength(8);
    outcome.results.forEach((r) => {
      expect(r.evaluator).toMatchObject({ type: 'ai-reviewer', name: 'Synthetic AI reviewer', version: 'reviewer-config-7' });
      expect(r.provenance.sourceFile).toBe('review.json');
      expect(r.review.state).toBe('needs-spot-check');
      expect(r.importRef?.batchId).toBe('batch-copy');
      expect(countsInReports(r)).toBe(false);
    });
  });

  it('rejects the malformed entry with a clear message and imports the rest', async () => {
    const store = await storeWithoutBatch();
    const outcome = importAssessmentBatch({ ...batchFile(), batchId: 'batch-copy' }, ctx(store));
    expect(outcome.rejected).toHaveLength(1);
    const message = outcome.rejected[0]?.message ?? '';
    expect(message).toContain('entry-malformed-outcome');
    expect(message).toContain('outcome');
    expect(message).toContain('"excellent"');
    expect(message).toContain('was rejected');
  });

  it.each([
    { name: 'a newer, unknown format version', file: { schemaVersion: 2 }, says: 'newer version' },
    { name: 'a file that is not a batch', file: { schema: 'eval-lab/something-else' }, says: 'not a "eval-lab/imported-assessment-batch" file' },
    { name: 'a batch without an evaluator', file: { evaluator: undefined }, says: 'evaluator' },
  ])('refuses $name with a plain message', async ({ file, says }) => {
    const store = await storeWithoutBatch();
    const outcome = importAssessmentBatch({ ...batchFile(), batchId: 'b2', ...file }, ctx(store));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.message).toContain(says);
  });

  it('refuses to import the same batch twice', async () => {
    const store = await storeWithoutBatch();
    const outcome = importAssessmentBatch(batchFile(), ctx(store));
    expect(outcome.ok ? '' : outcome.message).toContain('already imported');
  });

  it('rejects entries that point at outputs or criteria the lab does not have', async () => {
    const store = await storeWithoutBatch();
    const batch = batchFile();
    const [first] = batch['assessments'] as Array<Record<string, unknown>>;
    const outcome = importAssessmentBatch(
      {
        ...batch,
        batchId: 'b3',
        assessments: [
          { ...first, entryId: 'ghost-output', outputId: 'out-does-not-exist' },
          { ...first, entryId: 'ghost-criterion', findings: [{ criterionId: 'not-a-criterion', outcome: 'pass' }] },
        ],
        comparisons: [],
      },
      ctx(store),
    );
    expect(outcome.ok).toBe(false);
    const messages = outcome.rejected.map((r) => r.message).join(' ');
    expect(messages).toContain('"out-does-not-exist" does not exist');
    expect(messages).toContain('"not-a-criterion" is not in profile');
  });
});

describe('spot-checking', () => {
  it('keeps both the reviewer’s original and the owner’s corrected findings', async () => {
    const store = await freshStore();
    const pending = store.snapshot().results.find((r) => r.review.state === 'needs-spot-check');
    if (!pending) throw new Error('no pending assessment');
    const profile = findProfile(store.snapshot(), pending.profileId, pending.profileVersion);
    if (!profile) throw new Error('profile missing');
    const [firstFinding] = pending.findings;
    if (!firstFinding) throw new Error('no findings');
    const flipped = { ...firstFinding, outcome: firstFinding.outcome === 'fail' ? 'pass' : 'fail', explanation: 'Owner disagrees.' };
    const corrected = correctResult(pending, [flipped, ...pending.findings.slice(1)], profile, 'Owner', 'Too lenient', AT);
    expect(corrected.review.state).toBe('corrected');
    expect(corrected.review.originalFindings).toEqual(pending.findings);
    expect(corrected.findings[0]).toMatchObject({ outcome: flipped.outcome, correctedByOwner: true });
    expect(corrected.findings.slice(1).every((f) => !f.correctedByOwner)).toBe(true);
    expect(corrected.evaluator).toEqual(pending.evaluator);
    expect(countsInReports(corrected)).toBe(true);
  });

  it('treats a "correction" that changes nothing as an acceptance', async () => {
    const store = await freshStore();
    const pending = store.snapshot().results.find((r) => r.review.state === 'needs-spot-check');
    const profile = pending && findProfile(store.snapshot(), pending.profileId, pending.profileVersion);
    if (!pending || !profile) throw new Error('fixture missing');
    expect(correctResult(pending, pending.findings, profile, 'Owner', '', AT).review.state).toBe('accepted');
  });

  it('allows accepting the rest of a batch only after the sample has been checked one by one', async () => {
    const store = await freshStore();
    const batch = findBatch(store.snapshot(), BATCH_ID);
    if (!batch) throw new Error('batch missing');
    expect(batch.spotCheckSample).toBe(2);
    expect(() => acceptRemaining(batch, store.snapshot(), 'Owner', AT)).toThrow('Check at least 2');

    const pending = store.snapshot().results.filter((r) => r.importRef?.batchId === BATCH_ID);
    const [a, b] = pending;
    if (!a || !b) throw new Error('fixture missing');
    await store.replace('results', acceptResult(a, 'Owner', AT));
    expect(batchProgress(batch, store.snapshot()).canAcceptRest).toBe(false);
    await store.replace('results', rejectResult(b, 'Owner', 'Misread the case', AT));
    expect(batchProgress(batch, store.snapshot()).canAcceptRest).toBe(true);

    const rest = acceptRemaining(batch, store.snapshot(), 'Owner', AT);
    expect(rest).toHaveLength(6);
    expect(rest.every((r) => r.review.state === 'accepted' && r.review.via === 'batch')).toBe(true);
  });

  it('keeps assessments awaiting spot-check and rejected ones out of History', async () => {
    const store = await freshStore();
    const ids = new Set(historyRows(store.snapshot()).map((r) => r.result.id));
    store.snapshot().results.filter((r) => r.review.state === 'needs-spot-check').forEach((r) => expect(ids.has(r.id)).toBe(false));
  });
});
