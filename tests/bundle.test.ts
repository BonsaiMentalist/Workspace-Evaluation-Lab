/* eslint-disable ts-patterns/no-magic-numbers -- counts read more clearly as literals in tests */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBundle, importBundle, resultsCsv } from '../src/domain/bundle.js';
import { COLLECTIONS } from '../src/storage/store.js';
import { EvaluationResult, SavedOutput, SHA256_PATTERN } from '../src/domain/schemas.js';
import { EXAMPLES_DIR } from '../src/paths.js';
import { freshStore } from './helpers.js';

describe('export and re-import', () => {
  it('round-trips every record into an empty lab without losing provenance, evaluator identity or review history', async () => {
    const source = await freshStore();
    const bundle = JSON.parse(JSON.stringify(buildBundle(source.snapshot()))) as unknown;
    const target = await freshStore(false);
    const outcome = importBundle(bundle, target.snapshot());
    expect(outcome.problems).toEqual([]);
    await COLLECTIONS.reduce(async (prev, c) => {
      await prev;
      await target.addMany(c, outcome.additions[c] as never[]);
    }, Promise.resolve());
    COLLECTIONS.forEach((c) => expect(target.snapshot()[c]).toEqual(source.snapshot()[c]));
    const ai = target.snapshot().results.find((r) => r.evaluator.type === 'ai-reviewer');
    expect(ai?.provenance.sourceFile).toBe('ai-reviewer-batch.json');
    expect(ai?.review.state).toBe('needs-spot-check');
  });

  it('skips identical records and reports conflicting ones instead of overwriting', async () => {
    const store = await freshStore();
    const bundle = buildBundle(store.snapshot());
    const [first, ...rest] = bundle.results as Array<Record<string, unknown>>;
    const changed = { ...bundle, results: [{ ...first, overallNote: 'edited elsewhere' }, ...rest] };
    const outcome = importBundle(changed, store.snapshot());
    expect(outcome.skippedIdentical).toBeGreaterThan(100);
    expect(outcome.problems).toHaveLength(1);
    expect(outcome.problems[0]).toContain('the existing record was kept');
    expect(COLLECTIONS.every((c) => !outcome.additions[c].length)).toBe(true);
  });

  it('refuses a frozen case whose content no longer matches its freeze hash', async () => {
    const store = await freshStore();
    const frozen = store.snapshot().cases.find((c) => c.status === 'frozen');
    const target = await freshStore(false);
    const outcome = importBundle({ ...buildBundle(target.snapshot()), cases: [{ ...frozen, task: 'tampered' }] }, target.snapshot());
    expect(outcome.problems[0]).toContain('no longer matches its freeze hash');
  });

  it('refuses records that point at cases or outputs missing from both the lab and the file', async () => {
    const store = await freshStore();
    const target = await freshStore(false);
    const result = store.snapshot().results[0];
    const outcome = importBundle({ ...buildBundle(target.snapshot()), results: [result] }, target.snapshot());
    expect(outcome.problems[0]).toContain('neither in the lab nor accepted from the file');
  });

  it('refuses a bundle from a newer format version', async () => {
    const store = await freshStore(false);
    expect(importBundle({ ...buildBundle(store.snapshot()), schemaVersion: 2 }, store.snapshot()).message).toContain('newer version');
  });
});

describe('older and incomplete records', () => {
  it('fills defaults for fields an older file leaves out, and keeps unknown as null rather than 0', () => {
    const minimal = SavedOutput.parse({
      schema: 'eval-lab/saved-output',
      schemaVersion: 1,
      id: 'out-minimal',
      caseId: 'c',
      caseVersion: 1,
      label: 'Minimal',
      provenance: { origin: 'user', source: 'file-import' },
      privacy: 'local-private',
      createdAt: '2026-10-01T00:00:00Z',
    });
    expect(minimal.resources.tokens).toBeNull();
    expect(minimal.resources.durationS).toBeNull();
    expect(minimal.producedBy.model).toBeNull();
    expect(minimal.workspace.job).toBeNull();
  });

  it('keeps a measured zero distinct from unknown', () => {
    const tokens = SavedOutput.shape.resources.parse({ tokens: { uncached: 0, output: 120 } }).tokens;
    expect(tokens?.uncached).toBe(0);
    expect(tokens?.thinking).toBeNull();
  });

  it('drops unknown fields from untrusted files instead of storing them', () => {
    const parsed = EvaluationResult.shape.evaluator.parse({ type: 'human', name: 'x', __proto__: { polluted: true }, extra: 'ignored' });
    expect(Object.keys(parsed)).not.toContain('extra');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('CSV export', () => {
  it('writes one row per result and neutralises cells a spreadsheet would run as formulas', async () => {
    const store = await freshStore();
    const [first] = store.snapshot().results;
    if (!first) throw new Error('fixture missing');
    const csv = resultsCsv([{ ...first, evaluator: { ...first.evaluator, name: '=HYPERLINK("http://x")' } }]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('result_id,recorded_at,specialist');
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});

describe('runner compatibility example', () => {
  it('imports as lab records that keep held-out status, the freeze-set hash, the baseline and the known failure', async () => {
    const raw: unknown = JSON.parse(readFileSync(join(EXAMPLES_DIR, 'runner-compat', 'lab-records-after-runner-import.json'), 'utf8'));
    const store = await freshStore(false);
    const outcome = importBundle(raw, store.snapshot());
    expect(outcome.problems).toEqual([]);
    const heldOut = outcome.additions.cases.find((c) => c.split === 'held-out');
    expect(SHA256_PATTERN.test(heldOut?.freeze?.freezeSetHash ?? '')).toBe(true);
    expect(outcome.additions.results.every((r) => r.baseline?.runId === 'runner-run-2026-10-13')).toBe(true);
    const known = outcome.additions.results.find((r) => r.knownFailure);
    const clean = outcome.additions.results.find((r) => !r.knownFailure);
    expect(known?.findings.some((f) => f.outcome === 'fail')).toBe(true);
    expect(clean?.findings.every((f) => f.outcome === 'pass')).toBe(true);
  });
});
