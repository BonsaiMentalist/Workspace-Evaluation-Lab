/* eslint-disable ts-patterns/no-magic-numbers -- limits in check definitions read more clearly as literals in tests */
import { describe, expect, it } from 'vitest';
import { DeterministicCheck } from '../src/domain/schemas.js';
import { runCheck } from '../src/domain/checks.js';
import { checkResult } from '../src/domain/results.js';
import { findCase, findOutput, profileForCase } from '../src/domain/lookup.js';
import { freshStore } from './helpers.js';

const check = (raw: Record<string, unknown>): DeterministicCheck => DeterministicCheck.parse({ id: 'c1', criterionId: 'x', ...raw });

describe('deterministic checks', () => {
  it.each([
    { name: 'required phrase, any, found despite case and spacing', c: { type: 'required-phrase', phrases: ['Two jobs  COLLIDE'] }, text: 'Note: two jobs collide on nav.ts', passed: true },
    { name: 'required phrase, all, one missing', c: { type: 'required-phrase', phrases: ['alpha', 'beta'], match: 'all' }, text: 'alpha only', passed: false },
    { name: 'forbidden claim present', c: { type: 'forbidden-phrase', phrases: ['waiting for you'] }, text: 'Item 4 is still waiting for you.', passed: false },
    { name: 'forbidden claim absent', c: { type: 'forbidden-phrase', phrases: ['waiting for you'] }, text: 'Item 4 was done on 12 Oct.', passed: true },
    { name: 'label in markdown', c: { type: 'expected-label', label: 'Decision', accepted: ['reject'] }, text: '**Decision**: Reject.', passed: true },
    { name: 'label with the wrong value', c: { type: 'expected-label', label: 'Decision', accepted: ['reject'] }, text: 'Decision: accept', passed: false },
    { name: 'label missing', c: { type: 'expected-label', label: 'Decision', accepted: ['reject'] }, text: 'I would reject it.', passed: false },
    { name: 'JSON field filled in a fenced block', c: { type: 'required-field', field: 'fix.rootCause' }, text: 'Result:\n```json\n{"fix":{"rootCause":"off by one"}}\n```', passed: true },
    { name: 'JSON field empty', c: { type: 'required-field', field: 'testsAdded' }, text: '{"testsAdded": []}', passed: false },
    { name: 'no JSON at all', c: { type: 'required-field', field: 'a' }, text: 'plain text', passed: false },
    { name: 'enough evidence cited', c: { type: 'evidence-reference', refs: ['E1', 'E2'], min: 2 }, text: 'Per [E1] and [E2].', passed: true },
    { name: 'too little evidence cited', c: { type: 'evidence-reference', refs: ['E1', 'E2'], min: 2 }, text: 'Per [E1] and [E9].', passed: false },
    { name: 'within word limit', c: { type: 'max-words', max: 3 }, text: 'one two three', passed: true },
    { name: 'over word limit', c: { type: 'max-words', max: 3 }, text: 'one two three four', passed: false },
  ])('$name', ({ c, text, passed }) => {
    const outcome = runCheck(check(c), text);
    expect(outcome.passed).toBe(passed);
    expect(outcome.cannotEstablish.length).toBeGreaterThan(0);
  });

  it('is reproducible: running the checks again gives the identical result id and findings', async () => {
    const store = await freshStore();
    const lab = store.snapshot();
    const testCase = findCase(lab, 'master-stale-status-003', 1);
    const output = findOutput(lab, 'out-master-stale-status-003-a');
    if (!testCase || !output) throw new Error('fixture missing');
    const profile = profileForCase(lab, testCase);
    if (!profile) throw new Error('profile missing');
    const first = checkResult(testCase, profile, output, 'user', '2026-10-01T00:00:00Z');
    const second = checkResult(testCase, profile, output, 'user', '2026-10-02T00:00:00Z');
    expect(second.id).toBe(first.id);
    expect(second.findings).toEqual(first.findings);
    expect(first.evaluator.type).toBe('deterministic-check');
    expect(first.findings.every((f) => f.explanation.includes('It cannot show'))).toBe(true);
  });

  it('separates a flawed output from a good one on the stale-status case', async () => {
    const store = await freshStore();
    const lab = store.snapshot();
    const testCase = findCase(lab, 'master-stale-status-003', 1);
    const profile = testCase && profileForCase(lab, testCase);
    const outputs = ['out-master-stale-status-003-a', 'out-master-stale-status-003-b'].map((id) => findOutput(lab, id));
    if (!testCase || !profile || outputs.some((o) => !o)) throw new Error('fixture missing');
    const verdicts = outputs.map((o) => (o ? checkResult(testCase, profile, o).findings.every((f) => f.outcome === 'pass') : null));
    expect(new Set(verdicts).size).toBe(2);
  });
});
