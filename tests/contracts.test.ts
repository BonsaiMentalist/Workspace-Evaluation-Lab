/* eslint-disable ts-patterns/no-magic-numbers -- piece numbers read more clearly as literals in tests */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyticsJobLineId, AnalyticsJobLine, checkJobLine, checkReplyLine, joinKeysOf, type AnalyticsJoinKeys } from '../src/domain/extensions/analyticsJoin.js';
import { parseExecutableReport, resultFromExecutableReport } from '../src/domain/extensions/executable.js';
import { AVAILABLE_JUDGES } from '../src/domain/extensions/judge.js';
import { EvaluationResult } from '../src/domain/schemas.js';
import { findCase, findOutput, profileForCase } from '../src/domain/lookup.js';
import { EXAMPLES_DIR } from '../src/paths.js';
import { freshStore } from './helpers.js';

const exampleResult = (): EvaluationResult =>
  EvaluationResult.parse(JSON.parse(readFileSync(join(EXAMPLES_DIR, 'analytics-join', 'evaluation-result.json'), 'utf8')));
const exampleJobLine = (): AnalyticsJobLine => AnalyticsJobLine.parse(JSON.parse(readFileSync(join(EXAMPLES_DIR, 'analytics-join', 'jobs.jsonl'), 'utf8').trim()));

describe('Workspace Analytics join contract', () => {
  it('lines up the example evaluation result with its Analytics job line', () => {
    const keys = joinKeysOf(exampleResult());
    const line = exampleJobLine();
    expect(analyticsJobLineId(keys)).toBe('tSYN9001:1:worker');
    expect(analyticsJobLineId(keys)).toBe(line.id);
    const check = checkJobLine(keys, line);
    expect(check.matches).toBe(true);
    expect(check.fields.every((f) => f.same === true)).toBe(true);
  });

  it('notices when the model or effort disagree', () => {
    const keys = joinKeysOf(exampleResult());
    const check = checkJobLine({ ...keys, model: 'claude-opus' }, exampleJobLine());
    expect(check.matches).toBe(false);
    expect(check.fields.find((f) => f.field === 'model')?.same).toBe(false);
  });

  it('never matches on unknown keys', () => {
    const unknown: AnalyticsJoinKeys = { job: null, piece: null, phase: null, reply: null, chat: null, model: null, effort: null, provider: null };
    expect(analyticsJobLineId(unknown)).toBeNull();
    expect(checkJobLine(unknown, exampleJobLine()).matches).toBe(false);
    expect(checkReplyLine(unknown, { v: 1, kind: 'reply', id: 'r1', at: 'x', chat: 'c', specialist: 's', provider: 'claude', model: 'm', effort: null }).matches).toBe(false);
  });

  it('matches a reply line on reply id, chat, model, effort and provider', () => {
    const keys: AnalyticsJoinKeys = { job: null, piece: null, phase: null, reply: 'rSYN1', chat: 'cSYN1', model: 'claude-sonnet', effort: 'medium', provider: 'claude' };
    const line = { v: 1 as const, kind: 'reply', id: 'rSYN1', at: '2026-10-01T00:00:00Z', chat: 'cSYN1', specialist: 'master', provider: 'claude', model: 'claude-sonnet', effort: 'medium' };
    expect(checkReplyLine(keys, line).matches).toBe(true);
  });

  it('carries the join keys on seeded outputs that came from Workspace jobs', async () => {
    const store = await freshStore();
    const withJob = store.snapshot().outputs.filter((o) => o.workspace.job);
    expect(withJob.length).toBeGreaterThan(0);
    withJob.forEach((o) => expect(analyticsJobLineId(joinKeysOf(o))).toContain(o.workspace.job ?? ''));
  });
});

describe('executable assessment contract', () => {
  it('turns a test-runner report into findings, keeps the baseline, and marks a tracked failure as known rather than new', async () => {
    const store = await freshStore();
    const lab = store.snapshot();
    const report = parseExecutableReport(JSON.parse(readFileSync(join(EXAMPLES_DIR, 'executable', 'engineering-test-report.json'), 'utf8')));
    const testCase = findCase(lab, report.caseId, report.caseVersion);
    const output = findOutput(lab, report.outputId);
    const profile = testCase && profileForCase(lab, testCase);
    if (!testCase || !output || !profile) throw new Error('fixture missing');
    const result = resultFromExecutableReport(report, testCase, profile, output, 'report.json', '2026-10-21T15:00:00Z');
    expect(result.evaluator.type).toBe('executable-runner');
    expect(result.findings.find((f) => f.criterionId === 'technical-correctness')?.outcome).toBe('pass');
    const regression = result.findings.find((f) => f.criterionId === 'regression-avoidance');
    expect(regression?.outcome).toBe('fail');
    expect(regression?.explanation).toContain('Known, tracked failure');
    expect(result.knownFailure?.reference).toContain('legacy export timezone');
    expect(result.baseline?.runId).toBe('synthetic-run-2026-10-14');
  });

  it('refuses a report naming a different output', async () => {
    const store = await freshStore();
    const lab = store.snapshot();
    const raw = JSON.parse(readFileSync(join(EXAMPLES_DIR, 'executable', 'engineering-test-report.json'), 'utf8')) as Record<string, unknown>;
    const report = parseExecutableReport({ ...raw, outputId: 'out-engineering-date-range-001-b' });
    const testCase = findCase(lab, report.caseId, report.caseVersion);
    const output = findOutput(lab, 'out-engineering-date-range-001-a');
    const profile = testCase && profileForCase(lab, testCase);
    if (!testCase || !output || !profile) throw new Error('fixture missing');
    expect(() => resultFromExecutableReport(report, testCase, profile, output, null, '2026-10-21T15:00:00Z')).toThrow('different case');
  });

  it('marks a criterion with no matching tests as inconclusive', () => {
    const raw = JSON.parse(readFileSync(join(EXAMPLES_DIR, 'executable', 'engineering-test-report.json'), 'utf8')) as Record<string, unknown>;
    const report = parseExecutableReport({ ...raw, criterionMapping: [{ criterionId: 'testing', testNamePrefix: 'no-such-prefix' }] });
    expect(report.tests.filter((t) => t.name.startsWith('no-such-prefix'))).toHaveLength(0);
  });
});

describe('future AI judging', () => {
  it('ships no judge in Stage 1', () => {
    expect(AVAILABLE_JUDGES).toHaveLength(0);
  });
});
