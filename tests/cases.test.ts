/* eslint-disable ts-patterns/no-magic-numbers -- version numbers and counts read more clearly as literals in tests */
import { describe, expect, it } from 'vitest';
import { caseContentHash, editCase, freezeCase, freezeIntact, LifecycleError, markEvaluated, testInputFor, validateCase, validationProblems } from '../src/domain/cases.js';
import { EvaluationCase } from '../src/domain/schemas.js';
import { findCase, latestCase, profileForCase } from '../src/domain/lookup.js';
import { StoreError } from '../src/storage/store.js';
import { freshStore } from './helpers.js';

const AT = '2026-10-01T00:00:00Z';

function draft(overrides: Record<string, unknown> = {}): EvaluationCase {
  return EvaluationCase.parse({
    schema: 'eval-lab/evaluation-case',
    schemaVersion: 1,
    id: 'case-under-test',
    version: 1,
    status: 'candidate',
    specialistId: 'master',
    profileVersion: 1,
    title: 'A test case',
    task: 'Decide whether to delegate.',
    contextNote: 'No extra context.',
    expected: { behaviour: 'Answers directly.', acceptanceCriteria: ['Does not delegate'], referenceAnswer: 'SECRET-ANSWER', answerKind: 'judgement' },
    methods: ['manual'],
    limitations: 'None known.',
    split: 'held-out',
    provenance: { origin: 'user', source: 'manual-entry' },
    privacy: 'local-private',
    createdAt: AT,
    ...overrides,
  });
}

describe('case lifecycle', () => {
  it('moves candidate → validated → frozen → evaluated', async () => {
    const store = await freshStore();
    const profile = profileForCase(store.snapshot(), draft());
    const validated = validateCase(draft(), profile, 'Owner', '', AT);
    expect(validated.status).toBe('validated');
    const frozen = freezeCase(validated, 'Owner', AT);
    expect(frozen.status).toBe('frozen');
    expect(frozen.freeze?.contentHash).toBe(caseContentHash(frozen));
    expect(markEvaluated(frozen).status).toBe('evaluated');
  });

  it('refuses to freeze a case that was never validated', () => {
    expect(() => freezeCase(draft(), 'Owner')).toThrow(LifecycleError);
  });

  it('lists in plain language what a case still needs before validation', async () => {
    const store = await freshStore();
    const incomplete = draft({ task: '', expected: { behaviour: '', acceptanceCriteria: [], answerKind: 'objective' }, limitations: '' });
    const problems = validationProblems(incomplete, profileForCase(store.snapshot(), incomplete));
    expect(problems).toEqual(
      expect.arrayContaining([
        'Describe the task being evaluated.',
        'Add at least one acceptance criterion.',
        'This case has an objective expected answer, so it needs authoritative evidence that supports it.',
        'State known limitations and ambiguities (write "None known" if there are none).',
      ]),
    );
    expect(() => validateCase(incomplete, profileForCase(store.snapshot(), incomplete), 'Owner')).toThrow('not ready to validate');
  });

  it('keeps the seeded incomplete candidate in candidate status with its problems listed', async () => {
    const store = await freshStore();
    const vague = latestCase(store.snapshot(), 'master-vague-request-006');
    expect(vague?.status).toBe('candidate');
    expect(vague && validationProblems(vague, profileForCase(store.snapshot(), vague)).length).toBeGreaterThan(0);
  });
});

describe('versioning of frozen benchmarks', () => {
  it('turns an edit of a frozen case into a new candidate version and leaves the frozen one untouched', () => {
    const frozen = freezeCase({ ...draft(), status: 'validated', validation: { validatedAt: AT, validatedBy: 'Owner', notes: '' } }, 'Owner', AT);
    const edit = editCase(frozen, { task: 'A changed task.' }, 1, 'Clarified the task');
    expect(edit.newVersion).toBe(true);
    expect(edit.case.version).toBe(2);
    expect(edit.case.status).toBe('candidate');
    expect(edit.case.previousVersion).toBe(1);
    expect(edit.case.freeze).toBeNull();
    expect(frozen.task).toBe('Decide whether to delegate.');
    expect(freezeIntact(frozen)).toBe(true);
  });

  it('edits a candidate in place and sends a validated case back to candidate', () => {
    expect(editCase(draft(), { title: 'Renamed' }, 1, '').newVersion).toBe(false);
    const validated = { ...draft(), status: 'validated' as const, validation: { validatedAt: AT, validatedBy: 'Owner', notes: '' } };
    const edited = editCase(validated, { title: 'Renamed' }, 1, '');
    expect(edited.case.status).toBe('candidate');
    expect(edited.case.validation).toBeNull();
  });

  it('detects a frozen case whose content was changed behind the lab’s back', () => {
    const frozen = freezeCase({ ...draft(), status: 'validated', validation: { validatedAt: AT, validatedBy: 'Owner', notes: '' } }, 'Owner', AT);
    expect(freezeIntact({ ...frozen, task: 'tampered' })).toBe(false);
  });

  it('refuses at the storage layer to change a frozen version’s test conditions, but allows archiving it', async () => {
    const store = await freshStore();
    const frozen = findCase(store.snapshot(), 'research-contradiction-001', 1);
    if (!frozen) throw new Error('fixture missing');
    await expect(store.replace('cases', { ...frozen, task: 'quietly changed' })).rejects.toThrow(StoreError);
    await expect(store.replace('cases', { ...frozen, archived: true })).resolves.toMatchObject({ archived: true });
  });
});

describe('held-out answers', () => {
  it('never puts expected answers, evidence notes, checks or the title into a model’s test input', () => {
    const input = JSON.stringify(testInputFor(draft()));
    expect(input).not.toContain('SECRET-ANSWER');
    expect(input).not.toContain('Answers directly.');
    expect(input).not.toContain('Does not delegate');
    expect(input).not.toContain('A test case');
    expect(input).toContain('Decide whether to delegate.');
  });
});
