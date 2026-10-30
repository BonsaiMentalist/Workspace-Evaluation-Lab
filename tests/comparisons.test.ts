/* eslint-disable ts-patterns/no-magic-numbers -- counts read more clearly as literals in tests */
import { describe, expect, it } from 'vitest';
import { acceptImportedPreference, assignBlindLabels, blindView, createComparison, preferredOutputId, recordPreference } from '../src/domain/comparisons.js';
import { compareOutputs, equivalenceOf, historyGroups, historyRows } from '../src/domain/report.js';
import { findCase, findOutput, outputsForCase, profileForCase } from '../src/domain/lookup.js';
import type { SavedOutput } from '../src/domain/schemas.js';
import { freshStore } from './helpers.js';

const OWNER = { type: 'human' as const, name: 'Owner', version: null, date: null };
const provenance = { origin: 'user' as const, source: 'manual-entry' as const, sourceFile: null, importedAt: null, note: '' };

describe('blind labels', () => {
  it('are fixed by the seed but unrelated to the order the outputs were given in', () => {
    const ids = ['out-1', 'out-2', 'out-3', 'out-4'];
    expect(assignBlindLabels(ids, 'seed-a')).toEqual(assignBlindLabels(ids, 'seed-a'));
    const orders = new Set(['s1', 's2', 's3', 's4', 's5', 's6'].map((seed) => assignBlindLabels(ids, seed).map((e) => e.outputId).join()));
    expect(orders.size).toBeGreaterThan(1);
    expect(assignBlindLabels(ids, 'x').map((e) => e.label)).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('blinded comparison', () => {
  it('shows no identifying field before a preference is recorded, then reveals the mapping', async () => {
    const store = await freshStore();
    const lab = store.snapshot();
    const outputs = outputsForCase(lab, 'master-stale-status-003', 1);
    const c = createComparison({ id: 'cmp-test', caseId: 'master-stale-status-003', caseVersion: 1, profileId: 'master', profileVersion: 1, outputIds: outputs.map((o) => o.id), criterionIds: [], provenance });
    const view = JSON.stringify(blindView(c, outputs));
    outputs.forEach((o) => {
      expect(view).not.toContain(o.id);
      expect(view).not.toContain(o.label);
      if (o.producedBy.model) expect(view).not.toContain(`"${o.producedBy.model}"`);
      if (o.configuration.configurationId) expect(view).not.toContain(o.configuration.configurationId);
    });
    const recorded = recordPreference(c, { overall: { choice: 'B', reason: 'Checks the newer record.' } }, OWNER);
    expect(recorded.status).toBe('recorded');
    expect(preferredOutputId(recorded)).toBe(c.entries.find((e) => e.label === 'B')?.outputId);
  });

  it.each([
    { name: 'a label that was not shown', preference: { overall: { choice: 'E', reason: 'x' } }, error: 'Choices must be one of' },
    { name: 'no reason', preference: { overall: { choice: 'A', reason: '' } }, error: 'reason is required' },
  ])('refuses a preference with $name', async ({ preference, error }) => {
    const c = createComparison({ id: 'cmp-x', caseId: 'c', caseVersion: 1, profileId: 'p', profileVersion: 1, outputIds: ['o1', 'o2'], criterionIds: [], provenance });
    expect(() => recordPreference(c, preference, OWNER)).toThrow(error);
  });

  it('records a tie or an inconclusive comparison with its reason', () => {
    const c = createComparison({ id: 'cmp-t', caseId: 'c', caseVersion: 1, profileId: 'p', profileVersion: 1, outputIds: ['o1', 'o2'], criterionIds: [], provenance });
    expect(preferredOutputId(recordPreference(c, { overall: { choice: 'tie', reason: 'Equally good.' } }, OWNER))).toBe('tie');
    expect(preferredOutputId(recordPreference(c, { overall: { choice: 'inconclusive', reason: 'Cannot tell from this case.' } }, OWNER))).toBe('inconclusive');
  });

  it('keeps an imported AI preference hidden behind labels until the owner accepts it', async () => {
    const store = await freshStore();
    const imported = store.snapshot().comparisons.find((c) => c.importRef);
    if (!imported) throw new Error('fixture missing');
    expect(imported.status).toBe('open');
    expect(imported.review.state).toBe('needs-spot-check');
    expect(['A', 'B']).toContain(imported.importedPreference?.overall.choice);
    const accepted = acceptImportedPreference(imported, 'Owner');
    expect(accepted.status).toBe('recorded');
    expect(accepted.evaluator?.type).toBe('ai-reviewer');
  });
});

describe('comparison report', () => {
  const output = (o: SavedOutput, change: Partial<SavedOutput['producedBy']>, config?: string): SavedOutput => ({
    ...o,
    producedBy: { ...o.producedBy, ...change },
    configuration: { ...o.configuration, configurationId: config ?? o.configuration.configurationId },
  });

  it('calls a one-variable difference equivalent and a two-variable difference only partially equivalent', async () => {
    const store = await freshStore();
    const [a, b] = outputsForCase(store.snapshot(), 'master-stale-status-003', 1);
    if (!a || !b) throw new Error('fixture missing');
    const base = output(a, { model: 'claude-opus', effort: 'high' }, 'cfg-1');
    expect(equivalenceOf([base, output(b, { model: 'claude-sonnet', effort: 'high' }, 'cfg-1')], []).level).toBe('equivalent');
    const both = equivalenceOf([base, output(b, { model: 'claude-sonnet', effort: 'high' }, 'cfg-2')], []);
    expect(both.level).toBe('partially-equivalent');
    expect(both.reasons.join(' ')).toContain('cannot be pinned');
    expect(equivalenceOf([base, { ...b, caseId: 'another-case' }], []).level).toBe('not-comparable');
  });

  it('flags results judged against different rubric versions', async () => {
    const store = await freshStore();
    const lab = store.snapshot();
    const output = findOutput(lab, 'out-engineering-date-range-001-a');
    if (!output) throw new Error('fixture missing');
    const results = lab.results.filter((r) => r.outputId === output.id);
    expect(new Set(results.map((r) => r.profileVersion)).size).toBe(2);
    expect(equivalenceOf([output], results).reasons.join(' ')).toContain('different rubric versions');
  });

  it('names the criteria that favour each output, marks practically significant ones, and never generalises from one case', async () => {
    const store = await freshStore();
    const lab = store.snapshot();
    const testCase = findCase(lab, 'master-stale-status-003', 1);
    const profile = testCase && profileForCase(lab, testCase);
    if (!testCase || !profile) throw new Error('fixture missing');
    const report = compareOutputs(profile, outputsForCase(lab, testCase.id, 1), lab.results);
    const status = report.rows.find((r) => r.criterion.mandatory && r.significance === 'major');
    expect(status).toBeDefined();
    expect(Object.values(report.favouredCounts).some((n) => n > 0)).toBe(true);
    expect(report.enoughObservations.enough).toBe(false);
    expect(report.furtherExperiment.justified).toBe('yes');
  });

  it('does not compare criteria assessed by different kinds of evaluator', async () => {
    const store = await freshStore();
    const lab = store.snapshot();
    const [a, b] = outputsForCase(lab, 'master-stale-status-003', 1);
    const testCase = findCase(lab, 'master-stale-status-003', 1);
    const profile = testCase && profileForCase(lab, testCase);
    if (!a || !b || !profile) throw new Error('fixture missing');
    const results = lab.results.filter((r) => r.outputId === a.id || r.outputId === b.id);
    const mixed = results.map((r) => (r.outputId === b.id ? { ...r, evaluator: { ...r.evaluator, type: 'deterministic-check' as const } } : r));
    const report = compareOutputs(profile, [a, b], mixed);
    expect(report.rows.every((r) => r.favours === 'unclear')).toBe(true);
    expect(report.furtherExperiment.justified).toBe('improve-case-first');
  });
});

describe('history', () => {
  it('warns when a result used an older rubric and when a group has too few cases', async () => {
    const store = await freshStore();
    const rows = historyRows(store.snapshot());
    const old = rows.find((r) => r.result.id === 'res-engineering-date-range-001-a-v1');
    expect(old?.warnings.join(' ')).toContain('Rubric is now at version 2');
    const groups = historyGroups(rows);
    expect(groups.some((g) => g.warnings.some((w) => w.includes('too few to see a pattern')))).toBe(true);
    expect(groups.every((g) => Object.values(g.outcomeCounts).every(Number.isInteger))).toBe(true);
  });
});
