/**
 * Writes `examples/runner-compat/lab-records-after-runner-import.json`: an
 * illustration of what the lab's own records look like after a later stage
 * imports cases and results from AI Workspace's existing test runner.
 *
 * It does not describe that runner's file format (which this repository does
 * not know). It shows that the lab's formats keep the four properties the
 * runner relies on: held-out versus development cases, the freeze hash, the
 * baseline a run was compared against, and "known failure" as distinct from
 * a new failure. Cases go through the real lifecycle, so freeze hashes are genuine.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import type { EvaluationCase, EvaluationResult, SavedOutput, SpecialistProfile } from '../src/domain/schemas.js';
import { EvaluationCase as CaseSchema, EvaluationResult as ResultSchema, Finding as FindingSchema, SavedOutput as OutputSchema, SpecialistProfile as ProfileSchema } from '../src/domain/schemas.js';
import { freezeCase, validateCase } from '../src/domain/cases.js';
import { buildBundle } from '../src/domain/bundle.js';
import { hashOf } from '../src/domain/hash.js';
import { scoreFindings } from '../src/domain/scoring.js';
import { EXAMPLES_DIR } from '../src/paths.js';

const AT = '2026-10-20T08:00:00Z';
const RUNNER = 'memory test runner (illustrative name)';
const FREEZE_SET = 'held-out-freeze-2026-10';
const INDENT = 2;
const synthetic = { origin: 'synthetic', source: 'runner-import', sourceFile: 'runner-results-2026-10-20.json', importedAt: AT, note: 'Illustration only.' } as const;

const profile: SpecialistProfile = ProfileSchema.parse({
  schema: 'eval-lab/specialist-profile',
  schemaVersion: 1,
  id: 'memory-retrieval',
  version: 1,
  name: 'Memory retrieval (illustration)',
  purpose: 'Illustrates how runner-style memory test cases map onto lab records.',
  capabilities: [{ id: 'primary', name: 'Retrieval' }],
  criteria: [
    { id: 'finds-relevant-records', name: 'Finds the relevant records', tier: 'core', mandatory: true, methods: ['executable'] },
    { id: 'leaves-out-irrelevant', name: 'Leaves out irrelevant records', tier: 'core', methods: ['executable'] },
  ],
  createdAt: AT,
  origin: 'synthetic',
});

const caseDraft = (id: string, split: 'development' | 'held-out', task: string): EvaluationCase =>
  CaseSchema.parse({
    schema: 'eval-lab/evaluation-case',
    schemaVersion: 1,
    id,
    version: 1,
    status: 'candidate',
    split,
    specialistId: profile.id,
    profileVersion: 1,
    title: `Memory lookup: ${task}`,
    task,
    contextNote: 'A fictional memory store of twenty synthetic notes.',
    expected: { behaviour: 'Return the notes about the topic and nothing else.', acceptanceCriteria: ['All relevant notes returned', 'No unrelated notes returned'], answerKind: 'objective' },
    evidence: [{ id: 'E1', description: 'The runner’s expected-record list for this case.' }],
    methods: ['executable'],
    limitations: 'None known.',
    externalRef: { system: 'workspace-memory-test-runner', id: id.replace('mem-', 'case-') },
    provenance: synthetic,
    privacy: 'synthetic',
    createdAt: AT,
  });

const drafts = [caseDraft('mem-garden-notes', 'development', 'notes about the garden plan'), caseDraft('mem-travel-dates', 'held-out', 'notes about travel dates')];
const frozenOnce = drafts.map((c) => freezeCase(validateCase(c, profile, RUNNER, 'Imported frozen', AT), RUNNER, AT));
// The runner locks its held-out split with one freeze record: the case ids plus a content hash.
const freezeSetHash = hashOf(frozenOnce.filter((c) => c.split === 'held-out').map((c) => [c.id, c.freeze?.contentHash]));
const cases = frozenOnce.map((c) => (c.split === 'held-out' && c.freeze ? { ...c, status: 'evaluated' as const, freeze: { ...c.freeze, freezeSetId: FREEZE_SET, freezeSetHash } } : { ...c, status: 'evaluated' as const }));

const outputs: SavedOutput[] = cases.map((c) =>
  OutputSchema.parse({
    schema: 'eval-lab/saved-output',
    schemaVersion: 1,
    id: `out-${c.id}`,
    caseId: c.id,
    caseVersion: c.version,
    label: 'Memory step 6 · retrieval config r12',
    text: 'Returned note ids: n03, n07, n11.',
    producedBy: { model: null, provider: null, effort: null },
    configuration: { configurationId: 'memory-retrieval-r12' },
    provenance: synthetic,
    privacy: 'synthetic',
    createdAt: AT,
  }),
);

const result = (c: EvaluationCase, id: string, findingInputs: ReadonlyArray<z.input<typeof FindingSchema>>, extra: Partial<EvaluationResult>): EvaluationResult => {
  const findings = findingInputs.map((f) => FindingSchema.parse(f));
  return ResultSchema.parse({
    schema: 'eval-lab/evaluation-result',
    schemaVersion: 1,
    id,
    runId: 'runner-run-2026-10-20',
    caseId: c.id,
    caseVersion: c.version,
    split: c.split,
    profileId: profile.id,
    profileVersion: profile.version,
    outputId: `out-${c.id}`,
    configuration: { configurationId: 'memory-retrieval-r12' },
    methods: ['executable'],
    evaluator: { type: 'executable-runner', name: RUNNER, version: 'r12', date: AT },
    findings,
    overall: scoreFindings(profile, findings).overall,
    baseline: { runId: 'runner-run-2026-10-13', resultId: null, label: 'Saved baseline the run was compared against' },
    provenance: synthetic,
    createdAt: AT,
    ...extra,
  });
};

const [garden, travel] = cases;
if (!garden || !travel) throw new Error('example cases missing');
const results = [
  result(garden, 'res-mem-garden-notes', [
    { criterionId: 'finds-relevant-records', outcome: 'pass', explanation: 'All 3 expected notes returned.', method: 'executable' },
    { criterionId: 'leaves-out-irrelevant', outcome: 'pass', explanation: 'No extra notes.', method: 'executable' },
  ], {}),
  result(travel, 'res-mem-travel-dates', [
    { criterionId: 'finds-relevant-records', outcome: 'pass', explanation: 'Both expected notes returned.', method: 'executable' },
    { criterionId: 'leaves-out-irrelevant', outcome: 'fail', explanation: 'One unrelated note returned; already on the runner’s known-failure list.', method: 'executable' },
  ], { knownFailure: { reference: 'known-failure KF-2: travel notes over-match', since: '2026-10-06T00:00:00Z' } }),
];

const bundle = { ...buildBundle({ profiles: [profile], cases, outputs, results, comparisons: [], observations: [], importBatches: [] }, AT), note: 'Illustration: lab records after importing runner cases and results. See docs/ARCHITECTURE.md, "Importing from the existing test runner".' };
writeFileSync(join(EXAMPLES_DIR, 'runner-compat', 'lab-records-after-runner-import.json'), `${JSON.stringify(bundle, null, INDENT)}\n`);
console.log('Wrote runner-compat example.');
