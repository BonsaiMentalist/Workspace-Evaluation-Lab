/* eslint-disable ts-patterns/no-magic-numbers -- weights and ratings read more clearly as literals in tests */
import { describe, expect, it } from 'vitest';
import { SpecialistProfile, type Finding, type Outcome, type OverallStatus } from '../src/domain/schemas.js';
import { assessedBy, countsInReports, scoreFindings, shareAsPercent } from '../src/domain/scoring.js';

const profile = SpecialistProfile.parse({
  schema: 'eval-lab/specialist-profile',
  schemaVersion: 1,
  id: 'lore-like',
  version: 1,
  name: 'Lore-like',
  capabilities: [
    { id: 'primary', name: 'Canon management' },
    { id: 'prose', name: 'Literary prose', optional: true },
  ],
  criteria: [
    { id: 'canon', name: 'Canon fidelity', tier: 'core', mandatory: true, weight: 1, methods: ['manual'] },
    { id: 'continuity', name: 'Continuity', tier: 'core', weight: 1, methods: ['manual'] },
    { id: 'logic', name: 'Narrative logic', tier: 'core', weight: 1, methods: ['manual'] },
    { id: 'intent', name: 'Creator intent', tier: 'optional', weight: 1, methods: ['manual'] },
    { id: 'voice', name: 'Voice', tier: 'optional', capability: 'prose', weight: 20, methods: ['manual'], scale: { kind: 'rating', min: 1, max: 5 } },
  ],
  createdAt: '2026-10-01T00:00:00Z',
  origin: 'synthetic',
});

const f = (criterionId: string, outcome: Outcome): Finding => ({
  criterionId,
  outcome,
  rating: null,
  explanation: '',
  evidenceRefs: [],
  method: 'manual',
  checkId: null,
  correctedByOwner: false,
});

describe('overall outcome', () => {
  it.each<{ name: string; findings: Finding[]; expected: OverallStatus }>([
    { name: 'all core passed', findings: [f('canon', 'pass'), f('continuity', 'pass'), f('logic', 'pass')], expected: 'pass' },
    { name: 'a mandatory failure, everything else perfect', findings: [f('canon', 'fail'), f('continuity', 'pass'), f('logic', 'pass'), f('intent', 'pass'), f('voice', 'pass')], expected: 'critical-failure' },
    { name: 'a non-mandatory core failure', findings: [f('canon', 'pass'), f('continuity', 'fail'), f('logic', 'pass')], expected: 'fail' },
    { name: 'a core criterion inconclusive', findings: [f('canon', 'pass'), f('continuity', 'inconclusive'), f('logic', 'pass')], expected: 'inconclusive' },
    { name: 'a core criterion not assessed', findings: [f('canon', 'pass'), f('continuity', 'pass')], expected: 'incomplete' },
    { name: 'only partly met or optional failures', findings: [f('canon', 'pass'), f('continuity', 'partial'), f('logic', 'pass'), f('intent', 'fail')], expected: 'pass-with-issues' },
    { name: 'not applicable core criteria', findings: [f('canon', 'pass'), f('continuity', 'not-applicable'), f('logic', 'pass')], expected: 'pass' },
  ])('$name → $expected', ({ findings, expected }) => {
    expect(scoreFindings(profile, findings).overall).toBe(expected);
  });

  it('never lets a high weighted share hide a mandatory failure', () => {
    const s = scoreFindings(profile, [f('canon', 'fail'), f('continuity', 'pass'), f('logic', 'pass'), f('intent', 'pass')]);
    const main = s.capabilities.find((c) => c.capabilityId === 'primary');
    expect(shareAsPercent(main?.weightedShare ?? null)).toBe(75);
    expect(s.overall).toBe('critical-failure');
    expect(s.criticalFailures.map((c) => c.id)).toEqual(['canon']);
  });

  it('reports an optional capability separately; heavy prose weight cannot change the canon verdict', () => {
    const weakProse = scoreFindings(profile, [f('canon', 'pass'), f('continuity', 'pass'), f('logic', 'pass'), f('voice', 'fail')]);
    expect(weakProse.overall).toBe('pass');
    expect(weakProse.capabilities.find((c) => c.capabilityId === 'prose')?.counts.fail).toBe(1);
    const lovelyProseBadCanon = scoreFindings(profile, [f('canon', 'fail'), f('continuity', 'pass'), f('logic', 'pass'), f('voice', 'pass')]);
    expect(lovelyProseBadCanon.overall).toBe('critical-failure');
  });

  it('leaves not-applicable and inconclusive findings out of the weighted share, and gives no share when nothing was assessed', () => {
    const s = scoreFindings(profile, [f('canon', 'pass'), f('continuity', 'not-applicable'), f('logic', 'inconclusive')]);
    expect(s.capabilities.find((c) => c.capabilityId === 'primary')?.weightedShare).toBe(1);
    expect(scoreFindings(profile, []).capabilities.every((c) => c.weightedShare === null)).toBe(true);
  });

  it('ignores and lists findings for criteria the rubric does not have', () => {
    expect(scoreFindings(profile, [f('canon', 'pass'), f('made-up', 'fail')]).unknownCriterionIds).toEqual(['made-up']);
  });
});

describe('who assessed a result', () => {
  it.each([
    { type: 'human', state: 'not-required', label: 'person', counts: true },
    { type: 'ai-reviewer', state: 'needs-spot-check', label: 'ai-reviewer', counts: false },
    { type: 'ai-reviewer', state: 'accepted', label: 'ai-reviewer', counts: true },
    { type: 'ai-reviewer', state: 'corrected', label: 'ai-reviewer-corrected', counts: true },
    { type: 'ai-reviewer', state: 'rejected', label: 'ai-reviewer', counts: false },
    { type: 'deterministic-check', state: 'not-required', label: 'automatic-check', counts: true },
  ] as const)('$type / $state → $label (counts: $counts)', ({ type, state, label, counts }) => {
    const r = { evaluator: { type, name: 'x', version: null, date: null }, review: { state, decidedAt: null, decidedBy: null, via: null, note: '', originalFindings: null } };
    expect(assessedBy(r)).toBe(label);
    expect(countsInReports(r)).toBe(counts);
  });
});
