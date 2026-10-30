/**
 * Local storage for lab records: one JSON file per collection inside the
 * lab's data folder (git-ignored), written atomically.
 *
 * Invariants a future edit must keep:
 * - Profile versions and saved outputs are never overwritten.
 * - A frozen or evaluated case version may only change its status
 *   (frozen → evaluated) or archive flag; its test conditions never change.
 * - Every record is validated against its schema before it is written.
 * - Writes are serialised, so two quick actions can't overwrite each other.
 */
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { z } from 'zod';
import {
  BlindedComparison,
  EvaluationCase,
  EvaluationResult,
  ImportBatchRecord,
  ProductionObservation,
  SavedOutput,
  SpecialistProfile,
} from '../domain/schemas.js';
import { caseContentHash } from '../domain/cases.js';
import type { LabSnapshot } from '../domain/lookup.js';
import { describeZodError } from '../domain/errors.js';

export type Collection = keyof LabSnapshot;
type RecordOf<TCollection extends Collection> = LabSnapshot[TCollection][number];

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

interface CollectionRule {
  readonly schema: z.ZodType;
  readonly file: string;
  readonly singular: string;
  readonly versioned: boolean;
  readonly replaceable: boolean;
}

const RULES = {
  profiles: { singular: 'profile', schema: SpecialistProfile, file: 'profiles.json', versioned: true, replaceable: false },
  cases: { singular: 'case', schema: EvaluationCase, file: 'cases.json', versioned: true, replaceable: true },
  outputs: { singular: 'output', schema: SavedOutput, file: 'outputs.json', versioned: false, replaceable: false },
  results: { singular: 'result', schema: EvaluationResult, file: 'results.json', versioned: false, replaceable: true },
  comparisons: { singular: 'comparison', schema: BlindedComparison, file: 'comparisons.json', versioned: false, replaceable: true },
  observations: { singular: 'observation', schema: ProductionObservation, file: 'observations.json', versioned: false, replaceable: true },
  importBatches: { singular: 'import batch', schema: ImportBatchRecord, file: 'import-batches.json', versioned: false, replaceable: false },
} as const satisfies Record<Collection, CollectionRule>;

export const COLLECTIONS = Object.keys(RULES) as Collection[]; // keys of a total Record over Collection
const RECORDS_DIR = 'records';
const ATTACHMENTS_DIR = 'attachments';
const INDENT = 1;
const TEMP_SUFFIX = '.tmp';
const SYNTHETIC = 'synthetic';
const FROZEN_STATES: ReadonlySet<string> = new Set(['frozen', 'evaluated']);

const README_TEXT = `This folder holds your Specialist Evaluation Lab data.

It stays on this computer. Git is told to ignore it (see .gitignore), so it is
never committed or uploaded. Back it up by copying the folder, or use
"Export everything" on the Settings / Data page.

records/      your cases, profiles, outputs, results, comparisons and observations
attachments/  images you added
`;

interface Keyed {
  readonly id: string;
  readonly version?: number;
}

const keyOf = (collection: Collection, record: Keyed): string => (RULES[collection].versioned ? `${record.id}@${String(record.version)}` : record.id);

const isSynthetic = (record: unknown): boolean => {
  const r = record as { origin?: unknown; provenance?: { origin?: unknown } }; // origin lives at the top for profiles and in provenance elsewhere
  return r.origin === SYNTHETIC || r.provenance?.origin === SYNTHETIC;
};

type Data = { -readonly [TCollection in Collection]: Array<RecordOf<TCollection>> };

const emptyData = (): Data => ({ profiles: [], cases: [], outputs: [], results: [], comparisons: [], observations: [], importBatches: [] });

export class LabStore {
  readonly dataDir: string;
  private data: Data;
  private tail: Promise<void> = Promise.resolve();

  private constructor(dataDir: string, data: Data) {
    this.dataDir = dataDir;
    this.data = data;
  }

  /** Opens (creating if needed) the store in `dataDir`. Reports whether it was new, so the caller can seed examples. */
  static async open(dataDir: string): Promise<{ store: LabStore; created: boolean }> {
    const dir = resolve(dataDir);
    const recordsDir = join(dir, RECORDS_DIR);
    const created = !existsSync(recordsDir);
    await mkdir(recordsDir, { recursive: true });
    await mkdir(join(dir, ATTACHMENTS_DIR), { recursive: true });
    if (created) await writeFile(join(dir, 'README.txt'), README_TEXT, 'utf8');
    const entries = await Promise.all(COLLECTIONS.map(async (collection) => [collection, await readCollection(recordsDir, collection)] as const));
    return { store: new LabStore(dir, Object.fromEntries(entries) as Data), created }; // one entry per collection, read just above
  }

  get attachmentsDir(): string {
    return join(this.dataDir, ATTACHMENTS_DIR);
  }

  snapshot(): LabSnapshot {
    return this.data;
  }

  private async exclusive<TValue>(work: () => Promise<TValue>): Promise<TValue> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async persist(collection: Collection): Promise<void> {
    const path = join(this.dataDir, RECORDS_DIR, RULES[collection].file);
    const temp = `${path}${TEMP_SUFFIX}`;
    await writeFile(temp, JSON.stringify(this.data[collection], null, INDENT), 'utf8');
    await rename(temp, path);
  }

  private validate<TCollection extends Collection>(collection: TCollection, record: unknown): RecordOf<TCollection> {
    const parsed = RULES[collection].schema.safeParse(record);
    if (!parsed.success) throw new StoreError(`Could not save this ${RULES[collection].singular}: ${describeZodError(parsed.error)}`);
    return parsed.data as RecordOf<TCollection>; // validated against this collection's schema
  }

  async add<TCollection extends Collection>(collection: TCollection, record: RecordOf<TCollection>): Promise<RecordOf<TCollection>> {
    const [saved] = await this.addMany(collection, [record]);
    if (!saved) throw new StoreError(`Could not save this ${RULES[collection].singular}`);
    return saved;
  }

  async addMany<TCollection extends Collection>(collection: TCollection, records: ReadonlyArray<RecordOf<TCollection>>): Promise<Array<RecordOf<TCollection>>> {
    return this.exclusive(async () => {
      const valid = records.map((r) => this.validate(collection, r));
      const existing = new Set((this.data[collection] as Keyed[]).map((r) => keyOf(collection, r)));
      const keys = valid.map((r) => keyOf(collection, r as Keyed));
      const clash = keys.find((k, i) => existing.has(k) || keys.indexOf(k) !== i);
      if (clash) throw new StoreError(`A record with id ${clash.replace('@', ' version ')} already exists`);
      (this.data[collection] as Array<RecordOf<TCollection>>) = [...this.data[collection], ...valid] as Array<RecordOf<TCollection>>; // same collection type
      await this.persist(collection);
      return valid;
    });
  }

  /**
   * Adds records to several collections as one step: everything is validated
   * and checked for clashes first, and nothing is written if anything fails.
   */
  async addAll(additions: { readonly [TCollection in Collection]?: ReadonlyArray<RecordOf<TCollection>> }): Promise<void> {
    return this.exclusive(async () => {
      const next = Object.fromEntries(
        COLLECTIONS.map((collection) => {
          const incoming = (additions[collection] ?? []) as readonly unknown[];
          const valid = incoming.map((r) => this.validate(collection, r));
          const existing = new Set((this.data[collection] as Keyed[]).map((r) => keyOf(collection, r)));
          const keys = valid.map((r) => keyOf(collection, r as Keyed));
          const clash = keys.find((k, i) => existing.has(k) || keys.indexOf(k) !== i);
          if (clash) throw new StoreError(`A record with id ${clash.replace('@', ' version ')} already exists; nothing was imported`);
          return [collection, [...(this.data[collection] as unknown[]), ...valid]];
        }),
      ) as Data; // one validated list per collection
      const changed = COLLECTIONS.filter((c) => (additions[c] ?? []).length);
      this.data = next;
      await Promise.all(changed.map((c) => this.persist(c)));
    });
  }

  async replace<TCollection extends Collection>(collection: TCollection, record: RecordOf<TCollection>): Promise<RecordOf<TCollection>> {
    return this.exclusive(async () => {
      if (!RULES[collection].replaceable) throw new StoreError(`Saved ${collection} cannot be changed; create a new version instead`);
      const next = this.validate(collection, record);
      const key = keyOf(collection, next as Keyed);
      const list = this.data[collection] as Array<RecordOf<TCollection>>;
      const index = list.findIndex((r) => keyOf(collection, r as Keyed) === key);
      if (index < 0) throw new StoreError(`No ${RULES[collection].singular} with id ${key.replace('@', ' version ')} exists`);
      if (collection === 'cases') guardFrozenCase(list[index] as EvaluationCase, next as EvaluationCase);
      (this.data[collection] as Array<RecordOf<TCollection>>) = list.map((r, i) => (i === index ? next : r));
      await this.persist(collection);
      return next;
    });
  }

  /**
   * Removes the synthetic example records, leaving the user's own records
   * untouched. Synthetic records that the user's own records depend on (a case,
   * output or profile version they point at) are kept, so nothing is orphaned.
   * Returns how many were removed and how many were kept for that reason.
   */
  async removeSynthetic(): Promise<{ removed: number; kept: number }> {
    return this.exclusive(async () => {
      const own = <TRecord>(list: readonly TRecord[]): TRecord[] => list.filter((r) => !isSynthetic(r));
      const d = this.data;
      const ownResults = own(d.results);
      const ownComparisons = own(d.comparisons);
      const neededOutputs = new Set([...ownResults.map((r) => r.outputId), ...ownComparisons.flatMap((c) => c.entries.map((e) => e.outputId))]);
      const keptOutputs = d.outputs.filter((o) => !isSynthetic(o) || neededOutputs.has(o.id));
      const neededCases = new Set([...keptOutputs, ...ownResults, ...ownComparisons].map((r) => `${r.caseId}@${r.caseVersion}`));
      const keptCases = d.cases.filter((c) => !isSynthetic(c) || neededCases.has(`${c.id}@${c.version}`));
      const neededProfiles = new Set([
        ...keptCases.flatMap((c) => (c.profileVersion === null ? [] : [`${c.specialistId}@${c.profileVersion}`])),
        ...[...ownResults, ...ownComparisons].map((r) => `${r.profileId}@${r.profileVersion}`),
      ]);
      const next: Data = {
        profiles: d.profiles.filter((p) => !isSynthetic(p) || neededProfiles.has(`${p.id}@${p.version}`)),
        cases: keptCases,
        outputs: keptOutputs,
        results: ownResults,
        comparisons: ownComparisons,
        observations: own(d.observations),
        importBatches: d.importBatches.filter((b) => !isSynthetic(b) || ownResults.some((r) => r.importRef?.batchId === b.id)),
      };
      const before = COLLECTIONS.reduce((sum, c) => sum + (d[c] as unknown[]).length, 0);
      const after = COLLECTIONS.reduce((sum, c) => sum + (next[c] as unknown[]).length, 0);
      const ownCount = COLLECTIONS.reduce((sum, c) => sum + (d[c] as unknown[]).filter((r) => !isSynthetic(r)).length, 0);
      this.data = next;
      await Promise.all(COLLECTIONS.map((c) => this.persist(c)));
      return { removed: before - after, kept: after - ownCount };
    });
  }

  /** Deletes all records (used by tests and "start fresh"). Attachments are removed too. */
  async clearAll(): Promise<void> {
    return this.exclusive(async () => {
      this.data = emptyData();
      await Promise.all(COLLECTIONS.map((c) => this.persist(c)));
      await rm(this.attachmentsDir, { recursive: true, force: true });
      await mkdir(this.attachmentsDir, { recursive: true });
    });
  }
}

function guardFrozenCase(previous: EvaluationCase, next: EvaluationCase): void {
  if (!FROZEN_STATES.has(previous.status)) return;
  if (caseContentHash(previous) !== caseContentHash(next) || previous.freeze?.contentHash !== next.freeze?.contentHash)
    throw new StoreError('A frozen case version cannot be changed. Edit it to create a new version instead');
}

async function readCollection(recordsDir: string, collection: Collection): Promise<unknown[]> {
  const path = join(recordsDir, RULES[collection].file);
  if (!existsSync(path)) return [];
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(raw)) throw new StoreError(`The data file ${RULES[collection].file} is damaged (expected a list)`);
  return raw.map((record, index) => {
    const parsed = RULES[collection].schema.safeParse(record);
    if (!parsed.success) throw new StoreError(`Record ${index + 1} in ${RULES[collection].file} is damaged: ${describeZodError(parsed.error)}`);
    return parsed.data;
  });
}
