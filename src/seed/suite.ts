/**
 * Loads the synthetic starter suite from `fixtures/` into a store.
 *
 * Fixture cases name their target status; they are promoted through the real
 * lifecycle (validate, then freeze) rather than written as frozen, so the
 * starter suite exercises the same rules as the owner's own cases. Records
 * that already exist are left alone, so loading twice is harmless.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CaseStatus, EvaluationCase, EvaluationResult, SpecialistProfile } from '../domain/schemas.js';
import {
  EvaluationCase as EvaluationCaseSchema,
  EvaluationResult as EvaluationResultSchema,
  ProductionObservation,
  SavedOutput,
  SpecialistProfile as SpecialistProfileSchema,
} from '../domain/schemas.js';
import { freezeCase, markEvaluated, validateCase } from '../domain/cases.js';
import { importAssessmentBatch } from '../domain/imports.js';
import { findProfile } from '../domain/lookup.js';
import { scoreFindings } from '../domain/scoring.js';
import { nowIso } from '../domain/hash.js';
import type { LabStore } from '../storage/store.js';
import { FIXTURES_DIR } from '../paths.js';

const SUITE_DIR = join(FIXTURES_DIR, 'suite');
const AI_BATCH_FILE = 'ai-reviewer-batch.json';
const AI_BATCH_PATH = join(FIXTURES_DIR, 'assessments', AI_BATCH_FILE);
const OBSERVATIONS_PATH = join(FIXTURES_DIR, 'observations.json');
const SUITE_VALIDATOR = 'Synthetic suite';
const JSON_SUFFIX = '.json';

const SuiteFile = z.object({
  profiles: z.array(z.unknown()).default([]),
  cases: z.array(z.unknown()).default([]),
  outputs: z.array(z.unknown()).default([]),
  results: z.array(z.unknown()).default([]),
});

/** Lifecycle order; a status's position says how far along a case is. */
const LIFECYCLE: readonly CaseStatus[] = ['candidate', 'validated', 'frozen', 'evaluated'];
const stageOf = (status: CaseStatus): number => LIFECYCLE.indexOf(status);

export interface SeedReport {
  readonly added: number;
  readonly problems: readonly string[];
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function promote(raw: unknown, profiles: readonly SpecialistProfile[]): EvaluationCase {
  const target = EvaluationCaseSchema.parse(raw);
  const candidate: EvaluationCase = { ...target, status: 'candidate', validation: null, freeze: null };
  const profile = profiles.find((p) => p.id === target.specialistId && p.version === (target.profileVersion ?? p.version));
  const stage = stageOf(target.status);
  const steps: ReadonlyArray<readonly [CaseStatus, (c: EvaluationCase) => EvaluationCase]> = [
    ['validated', (c) => validateCase(c, profile, SUITE_VALIDATOR, '', target.createdAt)],
    ['frozen', (c) => freezeCase(c, SUITE_VALIDATOR, target.createdAt)],
    ['evaluated', markEvaluated],
  ];
  return steps.filter(([needed]) => stage >= stageOf(needed)).reduce((c, [, step]) => step(c), candidate);
}

export async function loadSyntheticSuite(store: LabStore): Promise<SeedReport> {
  if (!existsSync(SUITE_DIR)) return { added: 0, problems: ['The synthetic suite folder is missing.'] };
  const files = (await readdir(SUITE_DIR)).filter((f) => f.endsWith(JSON_SUFFIX)).sort();
  const suites = await Promise.all(files.map(async (f) => SuiteFile.parse(await readJson(join(SUITE_DIR, f)))));
  const lab = store.snapshot();
  const has = <TRecord extends { readonly id: string }>(list: readonly TRecord[], id: string): boolean => list.some((r) => r.id === id);

  const profiles = suites.flatMap((s) => s.profiles.map((p) => SpecialistProfileSchema.parse(p)));
  const newProfiles = profiles.filter((p) => !findProfile(lab, p.id, p.version));
  const cases = suites.flatMap((s) => s.cases.map((c) => promote(c, profiles)));
  const newCases = cases.filter((c) => !lab.cases.some((existing) => existing.id === c.id && existing.version === c.version));
  const outputs = suites.flatMap((s) => s.outputs.map((o) => SavedOutput.parse(o))).filter((o) => !has(lab.outputs, o.id));
  const results = suites
    .flatMap((s) => s.results.map((r) => EvaluationResultSchema.parse(r)))
    .filter((r) => !has(lab.results, r.id))
    .map((r): EvaluationResult => {
      const profile = profiles.find((p) => p.id === r.profileId && p.version === r.profileVersion);
      return profile ? { ...r, overall: scoreFindings(profile, r.findings).overall } : r;
    });

  await store.addMany('profiles', newProfiles);
  await store.addMany('cases', newCases);
  await store.addMany('outputs', outputs);
  await store.addMany('results', results);

  const observations = existsSync(OBSERVATIONS_PATH)
    ? z.array(z.unknown()).parse(await readJson(OBSERVATIONS_PATH)).map((o) => ProductionObservation.parse(o)).filter((o) => !has(store.snapshot().observations, o.id))
    : [];
  await store.addMany('observations', observations);

  const batchAdded = existsSync(AI_BATCH_PATH) ? await importSyntheticBatch(store) : { added: 0, problems: [] };
  return {
    added: newProfiles.length + newCases.length + outputs.length + results.length + observations.length + batchAdded.added,
    problems: batchAdded.problems,
  };
}

async function importSyntheticBatch(store: LabStore): Promise<SeedReport> {
  const outcome = importAssessmentBatch(await readJson(AI_BATCH_PATH), { lab: store.snapshot(), sourceFile: AI_BATCH_FILE, now: nowIso(), origin: 'synthetic' });
  if (!outcome.ok) return { added: 0, problems: outcome.message.startsWith('Batch') ? [] : [outcome.message] };
  await store.addMany('results', outcome.results);
  await store.addMany('comparisons', outcome.comparisons);
  await store.add('importBatches', outcome.batch);
  // The batch's malformed entry is rejected on purpose (it demonstrates the rejection message), so it is not a problem here.
  return { added: outcome.results.length + outcome.comparisons.length + 1, problems: [] };
}
