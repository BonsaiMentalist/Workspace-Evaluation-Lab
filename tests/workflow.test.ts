/* eslint-disable ts-patterns/no-magic-numbers -- HTTP status codes and counts read more clearly as literals in tests */
import { describe, expect, it } from 'vitest';
import { latestCase, latestProfile } from '../src/domain/lookup.js';
import { freezeIntact } from '../src/domain/cases.js';
import { CSRF, json, post, testLab } from './helpers.js';

const AT = '2026-10-28T09:00:00Z';
const location = (res: { headers: Record<string, string | undefined> }): string => (res.headers['location'] ?? '').split('?')[0] ?? '';

describe('complete synthetic workflow through the app', () => {
  it('creates, freezes, scores (by hand and by import), compares blind, exports and re-imports without losing provenance', async () => {
    const lab = await testLab();

    // 1. Create a candidate case through the form.
    const created = await lab.agent
      .post('/cases')
      .field('_csrf', CSRF)
      .field('title', 'Workflow: reconcile two release notes')
      .field('specialistId', 'research')
      .field('capability', 'primary')
      .field('split', 'development')
      .field('task', 'Two fictional release notes disagree about a feature date. Say which is right and why.')
      .field('context[0][title]', 'E1 · Release note A')
      .field('context[0][text]', 'Feature X shipped on 3 March.')
      .field('context[0][authoritative]', 'on')
      .field('behaviour', 'Notices the disagreement and weighs the sources.')
      .field('acceptanceCriteria', 'Names the contradiction\nDoes not invent a date')
      .field('answerKind', 'judgement')
      .field('methods', 'manual')
      .field('limitations', 'None known.')
      .field('privacy', 'local-private');
    expect(created.status).toBe(303);
    const casePath = location(created);
    const caseId = casePath.split('/')[2] ?? '';
    expect(caseId.startsWith('research-workflow-reconcile-two-release-notes-')).toBe(true);
    expect(casePath).toBe(`/cases/${caseId}/v/1`);
    expect(latestCase(lab.store.snapshot(), caseId)?.status).toBe('candidate');

    // 2. Validate and freeze.
    expect((await post(lab, `${casePath}/validate`)).status).toBe(303);
    expect((await post(lab, `${casePath}/freeze`)).status).toBe(303);
    const frozen = latestCase(lab.store.snapshot(), caseId);
    expect(frozen?.status).toBe('frozen');
    expect(frozen && freezeIntact(frozen)).toBe(true);

    // 3. Import two saved outputs.
    const output = (id: string, model: string, text: string): Record<string, unknown> => ({
      schema: 'eval-lab/saved-output',
      schemaVersion: 1,
      id,
      caseId,
      caseVersion: 1,
      label: `${model} answer`,
      text,
      producedBy: { model, provider: 'claude', effort: 'high' },
      configuration: { configurationId: 'research-v2' },
      workspace: { job: `tWF-${id}`, piece: 1, phase: 'worker' },
      provenance: { origin: 'user', source: 'file-import' },
      privacy: 'local-private',
      createdAt: AT,
    });
    const imported = await lab.agent
      .post('/outputs/import')
      .field('_csrf', CSRF)
      .attach('file', json([output('out-wf-a', 'claude-opus', 'The notes contradict each other [E1]; neither is confirmed.'), output('out-wf-b', 'claude-sonnet', 'Feature X shipped on 3 March.')]), 'outputs.json');
    expect(imported.status).toBe(200);
    expect(imported.text).toContain('2 output(s) imported');

    // 4a. Score output A by hand.
    const profile = latestProfile(lab.store.snapshot(), 'research');
    if (!profile) throw new Error('research profile missing');
    const findings = Object.fromEntries(
      profile.criteria.flatMap((c, i) => [
        [`findings[${i}][criterionId]`, c.id],
        [`findings[${i}][outcome]`, 'pass'],
        [`findings[${i}][explanation]`, `Meets ${c.name}.`],
      ]),
    );
    const scored = await post(lab, '/outputs/out-wf-a/score', { ...findings, evaluator: 'Owner', overallNote: 'Good.' });
    expect(scored.status).toBe(303);
    const manualPath = location(scored);
    expect((await lab.agent.get(manualPath)).text).toContain('Passed');

    // 4b. Import an AI reviewer's assessment of output B, spot-check it and accept it.
    const batch = {
      schema: 'eval-lab/imported-assessment-batch',
      schemaVersion: 1,
      batchId: 'batch-workflow-1',
      producedAt: AT,
      evaluator: { type: 'ai-reviewer', name: 'Workflow reviewer', version: 'cfg-1', date: AT },
      assessments: [
        {
          entryId: 'wf-b',
          caseId,
          caseVersion: 1,
          outputId: 'out-wf-b',
          findings: profile.criteria.map((c) => ({ criterionId: c.id, outcome: c.mandatory ? 'fail' : 'partial', explanation: 'Takes one source at face value.' })),
        },
      ],
    };
    const batchResponse = await lab.agent.post('/imports/assessments').field('_csrf', CSRF).attach('file', json(batch), 'workflow-review.json');
    expect(batchResponse.status).toBe(200);
    const aiResult = lab.store.snapshot().results.find((r) => r.importRef?.batchId === 'batch-workflow-1');
    expect(aiResult?.review.state).toBe('needs-spot-check');
    expect((await lab.agent.get(`/review/${aiResult?.id}`)).status).toBe(200);
    expect((await post(lab, `/review/${aiResult?.id}/accept`)).status).toBe(303);
    expect(lab.store.snapshot().results.find((r) => r.id === aiResult?.id)?.review.state).toBe('accepted');

    // 5. Blind comparison: identities hidden until the preference is recorded.
    const started = await post(lab, '/compare', { caseId, caseVersion: '1', outputIds: ['out-wf-a', 'out-wf-b'] });
    expect(started.status).toBe(303);
    const comparisonPath = location(started);
    const blindPage = (await lab.agent.get(comparisonPath)).text;
    ['claude-opus', 'claude-sonnet', 'out-wf-a', 'out-wf-b', 'research-v2', 'tWF-'].forEach((secret) => expect(blindPage).not.toContain(secret));
    expect(blindPage).toContain('Output A');
    const comparison = lab.store.snapshot().comparisons.find((c) => comparisonPath.endsWith(c.id));
    const labelOfA = comparison?.entries.find((e) => e.outputId === 'out-wf-a')?.label ?? 'A';
    expect((await post(lab, `${comparisonPath}/record`, { overall: labelOfA, reason: 'Notices the contradiction.' })).status).toBe(303);
    const revealed = (await lab.agent.get(comparisonPath)).text;
    expect(revealed).toContain('claude-opus');
    expect(revealed).toContain('Equivalent conditions');

    // 6. Findings recorded side by side.
    const report = await lab.agent.get(`/compare/report?case=${caseId}&version=1`);
    expect(report.status).toBe(200);
    // One output was scored by a person, the other by an AI reviewer: the report shows both but refuses to mix them into a verdict.
    expect(report.text).toContain('Not every output was assessed on this by the same kind of evaluator');
    expect(report.text).toContain('Person');
    expect(report.text).toContain('AI reviewer');
    expect(lab.store.snapshot().results.filter((r) => r.caseId === caseId)).toHaveLength(2);
    expect(latestCase(lab.store.snapshot(), caseId)?.status).toBe('evaluated');

    // 7. Export everything.
    const exported = await lab.agent.get('/data/export.json');
    expect(exported.status).toBe(200);
    expect(exported.headers['content-disposition']).toContain('.evallab-export.json');

    // 8. Re-import into a fresh, empty lab without losing provenance.
    const fresh = await testLab(false);
    const reimported = await fresh.agent.post('/data/import').field('_csrf', CSRF).attach('file', Buffer.from(exported.text), 'backup.json');
    expect(reimported.status).toBe(200);
    expect(reimported.text).toContain('0 not imported');
    const snapshot = fresh.store.snapshot();
    const ai = snapshot.results.find((r) => r.importRef?.batchId === 'batch-workflow-1');
    expect(ai?.evaluator).toMatchObject({ type: 'ai-reviewer', name: 'Workflow reviewer', version: 'cfg-1' });
    expect(ai?.provenance.sourceFile).toBe('workflow-review.json');
    expect(ai?.review).toMatchObject({ state: 'accepted', decidedBy: 'Owner', via: 'individual' });
    const manual = snapshot.results.find((r) => r.outputId === 'out-wf-a');
    expect(manual?.evaluator).toMatchObject({ type: 'human', name: 'Owner' });
    expect(snapshot.comparisons.find((c) => c.caseId === caseId)?.preference?.overall.reason).toBe('Notices the contradiction.');
    const restoredCase = latestCase(snapshot, caseId);
    expect(restoredCase?.status).toBe('evaluated');
    expect(restoredCase && freezeIntact(restoredCase)).toBe(true);
    expect(snapshot.outputs.find((o) => o.id === 'out-wf-b')?.workspace.job).toBe('tWF-out-wf-b');
  });

  it('shows an unknown measurement as "unknown", never as zero', async () => {
    const lab = await testLab();
    const output = lab.store.snapshot().outputs.find((o) => o.resources.tokens === null);
    if (!output) throw new Error('fixture missing');
    const page = (await lab.agent.get(`/outputs/${output.id}`)).text;
    expect(page).toContain('<span class="unknown">unknown</span>');
  });

  it('records an inconclusive assessment without inventing a verdict', async () => {
    const lab = await testLab();
    const profile = latestProfile(lab.store.snapshot(), 'master');
    const target = lab.store.snapshot().outputs.find((o) => o.caseId === 'master-branch-cleanup-005');
    if (!profile || !target) throw new Error('fixture missing');
    const findings = Object.fromEntries(
      profile.criteria.flatMap((c, i) => [
        [`findings[${i}][criterionId]`, c.id],
        [`findings[${i}][outcome]`, c.tier === 'core' ? 'inconclusive' : 'not-applicable'],
      ]),
    );
    const res = await post(lab, `/outputs/${target.id}/score`, findings);
    const result = lab.store.snapshot().results.find((r) => res.headers['location']?.includes(r.id));
    expect(result?.overall).toBe('inconclusive');
  });

  it('refuses to score an output of a case that is not frozen', async () => {
    const lab = await testLab();
    const res = await lab.agent.get('/evaluate/research-benchmark-replication-003/v/1');
    expect(res.status).toBe(400);
    expect(res.text).toContain('Validate and freeze the case first');
  });
});
