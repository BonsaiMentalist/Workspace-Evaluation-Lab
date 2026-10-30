/* eslint-disable ts-patterns/no-magic-numbers -- sizes, timings and counts read more clearly as literals in tests */
import { describe, expect, it } from 'vitest';
import { buildBundle, importBundle } from '../src/domain/bundle.js';
import { acceptImportedPreference, rejectImportedPreference } from '../src/domain/comparisons.js';
import { editCase, validateCase } from '../src/domain/cases.js';
import { runCheck } from '../src/domain/checks.js';
import { correctResult } from '../src/domain/imports.js';
import { compareOutputs } from '../src/domain/report.js';
import { DeterministicCheck, EvaluationCase } from '../src/domain/schemas.js';
import { findCase, findProfile, latestCase, latestProfile, outputsForCase, profileForCase } from '../src/domain/lookup.js';
import { COLLECTIONS } from '../src/storage/store.js';
import { CSRF, freshStore, post, testLab } from './helpers.js';

const AT = '2026-10-29T10:00:00Z';

describe('blind comparisons stay blind elsewhere in the lab', () => {
  it('warns before showing an output, result or spot-check of an output in an open comparison', async () => {
    const lab = await testLab();
    const open = lab.store.snapshot().comparisons.find((c) => c.status === 'open');
    const outputId = open?.entries[0]?.outputId ?? '';
    const pending = lab.store.snapshot().results.find((r) => r.outputId === outputId && r.review.state === 'needs-spot-check');
    const paths = [`/outputs/${outputId}`, `/outputs/${outputId}/score`, `/results/${pending?.id}`, `/review/${pending?.id}`];
    const pages = await Promise.all(paths.map(async (path) => (await lab.agent.get(path)).text));
    const output = lab.store.snapshot().outputs.find((o) => o.id === outputId);
    if (!output?.producedBy.model) throw new Error('fixture missing');
    pages.forEach((page) => {
      expect(page).toContain('This output is in an open blind comparison');
      expect(page).not.toContain(output.label);
      expect(page).not.toContain(output.producedBy.model);
    });
    expect((await lab.agent.get(`/outputs/${outputId}?reveal=1`)).text).toContain(output.label);
    const queue = (await lab.agent.get('/review')).text;
    expect(queue).toContain('Hidden while its blind comparison is open');
  });

  it('refuses to reject an imported preference once a preference is recorded', async () => {
    const store = await freshStore();
    const imported = store.snapshot().comparisons.find((c) => c.importRef);
    if (!imported) throw new Error('fixture missing');
    expect(() => rejectImportedPreference(acceptImportedPreference(imported, 'Owner'), 'Owner', 'changed my mind')).toThrow('already been recorded');
  });
});

describe('importing a lab export enforces the lab’s rules', () => {
  it('recomputes a stored outcome that hides a mandatory failure', async () => {
    const source = await freshStore();
    const critical = source.snapshot().results.find((r) => r.overall === 'critical-failure' && r.evaluator.type === 'human');
    if (!critical) throw new Error('fixture missing');
    const target = await freshStore(false);
    const bundle = buildBundle(source.snapshot());
    const outcome = importBundle({ ...bundle, results: [{ ...critical, overall: 'pass' }] }, target.snapshot());
    expect(outcome.additions.results[0]?.overall).toBe('critical-failure');
  });

  it.each([
    { name: 'a "frozen" case with no freeze record', edit: (b: Record<string, unknown[]>) => ({ cases: [{ ...(b['cases']?.find((c) => (c as { status: string }).status === 'frozen') as object), freeze: null }] }), says: 'no freeze record' },
    { name: 'a "validated" case with no validation record', edit: (b: Record<string, unknown[]>) => ({ cases: [{ ...(b['cases']?.find((c) => (c as { status: string }).status === 'validated') as object), validation: null }] }), says: 'no validation record' },
  ])('refuses $name', async ({ edit, says }) => {
    const source = await freshStore();
    const target = await freshStore(false);
    const bundle = buildBundle(source.snapshot()) as unknown as Record<string, unknown[]>;
    const outcome = importBundle({ ...bundle, ...edit(bundle) }, target.snapshot());
    expect(outcome.problems.join(' ')).toContain(says);
  });

  it('refuses an AI-reviewer result that claims it needs no spot-check, and an inconsistent correction', async () => {
    const source = await freshStore();
    const ai = source.snapshot().results.find((r) => r.evaluator.type === 'ai-reviewer');
    const human = source.snapshot().results.find((r) => r.evaluator.type === 'human');
    if (!ai || !human) throw new Error('fixture missing');
    const outcome = importBundle(
      {
        ...buildBundle(source.snapshot()),
        results: [
          { ...ai, id: 'res-sneaky-ai', review: { ...ai.review, state: 'not-required' } },
          { ...human, id: 'res-sneaky-correction', findings: human.findings.map((f) => ({ ...f, correctedByOwner: true })) },
        ],
      },
      source.snapshot(),
    );
    expect(outcome.problems.join(' ')).toContain('needing no spot-check');
    expect(outcome.problems.join(' ')).toContain('inconsistent correction record');
  });

  it('refuses ids repeated inside the file, and records depending on a refused case', async () => {
    const source = await freshStore();
    const target = await freshStore(false);
    const bundle = buildBundle(source.snapshot());
    const frozen = source.snapshot().cases.find((c) => c.status === 'frozen');
    const output = source.snapshot().outputs.find((o) => o.caseId === frozen?.id);
    const profile = source.snapshot().profiles.find((p) => p.id === frozen?.specialistId);
    const outcome = importBundle({ ...bundle, profiles: [profile], cases: [{ ...frozen, task: 'tampered' }], outputs: [output, output], results: [] }, target.snapshot());
    expect(outcome.problems.join(' ')).toContain('no longer matches its freeze hash');
    expect(outcome.problems.join(' ')).toContain('neither in the lab nor accepted from the file');
    expect(outcome.additions.outputs).toHaveLength(0);
  });

  it('writes an import all at once or not at all', async () => {
    const store = await freshStore();
    const before = COLLECTIONS.map((c) => store.snapshot()[c].length);
    const existing = store.snapshot().outputs[0];
    const newProfile = { ...store.snapshot().profiles[0], id: 'brand-new-profile' };
    await expect(store.addAll({ profiles: [newProfile as never], outputs: [existing as never] })).rejects.toThrow('nothing was imported');
    expect(COLLECTIONS.map((c) => store.snapshot()[c].length)).toEqual(before);
  });

  it('accepts a JSON file saved with a byte-order mark', async () => {
    const lab = await testLab(false);
    const exported = (await (await testLab()).agent.get('/data/export.json')).text;
    const res = await lab.agent.post('/data/import').field('_csrf', CSRF).attach('file', Buffer.from(`﻿${exported}`), 'backup.json');
    expect(res.status).toBe(200);
    expect(res.text).toContain('0 not imported');
  });
});

describe('synthetic examples and the owner’s own work', () => {
  it('makes an edited synthetic case the owner’s own', async () => {
    const store = await freshStore();
    const frozen = findCase(store.snapshot(), 'lore-tamsin-motivation-003', 1);
    if (!frozen) throw new Error('fixture missing');
    expect(editCase(frozen, { task: 'Changed.' }, 1, 'mine now').case.provenance.origin).toBe('user');
  });

  it('keeps synthetic records the owner’s own results depend on, so a later export re-imports cleanly', async () => {
    const lab = await testLab();
    const target = lab.store.snapshot().outputs.find((o) => o.caseId === 'master-delegation-001');
    const profile = latestProfile(lab.store.snapshot(), 'master');
    if (!target || !profile) throw new Error('fixture missing');
    const first = profile.criteria[0];
    await post(lab, `/outputs/${target.id}/score?reveal=1`, { 'findings[0][criterionId]': first?.id, 'findings[0][outcome]': 'pass' });
    const { kept } = await lab.store.removeSynthetic();
    expect(kept).toBeGreaterThan(0);
    expect(lab.store.snapshot().outputs.map((o) => o.id)).toContain(target.id);
    const fresh = await freshStore(false);
    expect(importBundle(buildBundle(lab.store.snapshot()), fresh.snapshot()).problems).toEqual([]);
  });
});

describe('smaller fixes', () => {
  it('pins the rubric version when a case is validated', async () => {
    const store = await freshStore();
    const draft = EvaluationCase.parse({ ...latestCase(store.snapshot(), 'master-vague-request-006'), profileVersion: null, expected: { behaviour: 'Asks.', acceptanceCriteria: ['Asks one question'] }, limitations: 'None known.' });
    const validated = validateCase(draft, profileForCase(store.snapshot(), draft), 'Owner', '', AT);
    expect(validated.profileVersion).toBe(1);
  });

  it('checks a label in a huge output quickly and keeps long values within the explanation limit', () => {
    const check = DeterministicCheck.parse({ id: 'c', criterionId: 'x', type: 'expected-label', label: 'Decision', accepted: ['reject'] });
    const started = Date.now();
    runCheck(check, `${'\n'.repeat(100_000)}${' '.repeat(50_000)}x`);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(runCheck(check, `Decision: ${'y'.repeat(10_000)}`).detail.length).toBeLessThan(1000);
  });

  it('counts a correction that only changes evidence references as a correction', async () => {
    const store = await freshStore();
    const pending = store.snapshot().results.find((r) => r.review.state === 'needs-spot-check');
    const profile = pending && findProfile(store.snapshot(), pending.profileId, pending.profileVersion);
    if (!pending || !profile) throw new Error('fixture missing');
    const changed = pending.findings.map((f, i) => (i ? f : { ...f, evidenceRefs: ['E9'] }));
    expect(correctResult(pending, changed, profile, 'Owner', '', AT).review.state).toBe('corrected');
  });

  it('warns when an output has no counted assessment even if another has two', async () => {
    const store = await freshStore();
    const lab = store.snapshot();
    const testCase = findCase(lab, 'master-stale-status-003', 1);
    const profile = testCase && profileForCase(lab, testCase);
    const [a, b] = outputsForCase(lab, 'master-stale-status-003', 1);
    if (!profile || !a || !b) throw new Error('fixture missing');
    const onlyA = lab.results.filter((r) => r.outputId === a.id);
    const report = compareOutputs(profile, [a, b], [...onlyA, ...onlyA.map((r) => ({ ...r, id: `${r.id}-copy` }))]);
    expect(report.uncertain.join(' ')).toContain('no counted assessment');
  });

  it('rejects a backslash redirect after a theme change and a malformed token without an error page', async () => {
    const lab = await testLab(false);
    expect((await post(lab, '/theme', { theme: 'light', back: '/\\evil.example/x' })).headers['location']).toBe('/');
    expect((await lab.agent.post('/theme').type('form').send({ _csrf: 'é'.repeat(CSRF.length) })).status).toBe(403);
  });

  it('keeps rating anchors when a profile is edited', async () => {
    const lab = await testLab();
    const lore = latestProfile(lab.store.snapshot(), 'lore');
    const rated = lore?.criteria.find((c) => c.scale.kind === 'rating');
    if (!lore || !rated || rated.scale.kind !== 'rating') throw new Error('fixture missing');
    const fields = Object.fromEntries([
      ['name', lore.name],
      ...lore.capabilities.flatMap((c, i) => [[`capabilities[${i}][id]`, c.id], [`capabilities[${i}][name]`, c.name], ...(c.optional ? [[`capabilities[${i}][optional]`, 'on']] : [])]),
      ...lore.criteria.flatMap((c, i) => [
        [`criteria[${i}][id]`, c.id],
        [`criteria[${i}][name]`, c.name],
        [`criteria[${i}][tier]`, c.tier],
        [`criteria[${i}][capability]`, c.capability],
        [`criteria[${i}][methods]`, 'manual'],
        ...(c.scale.kind === 'rating' ? [[`criteria[${i}][scale]`, 'rating'], [`criteria[${i}][min]`, String(c.scale.min)], [`criteria[${i}][max]`, String(c.scale.max)], [`criteria[${i}][anchors]`, c.scale.anchors]] : []),
      ]),
    ]);
    expect((await post(lab, '/profiles/lore/edit', fields)).status).toBe(303);
    const v2 = latestProfile(lab.store.snapshot(), 'lore')?.criteria.find((c) => c.id === rated.id);
    expect(v2?.scale).toEqual(rated.scale);
  });
});
