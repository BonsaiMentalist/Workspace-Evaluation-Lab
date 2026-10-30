/** Shared test setup: a temporary data folder, optionally seeded with the synthetic suite, and an app bound to it. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach } from 'vitest';
import { LabStore } from '../src/storage/store.js';
import { loadSyntheticSuite } from '../src/seed/suite.js';
import { createApp } from '../src/server/app.js';

export const CSRF = 'test-csrf-token-0123456789abcdef0123456789abcdef0123456789abcdef';

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((f) => rm(f, { recursive: true, force: true })));
});

export async function freshStore(seed = true): Promise<LabStore> {
  const dir = await mkdtemp(join(tmpdir(), 'eval-lab-test-'));
  folders.push(dir);
  const { store } = await LabStore.open(dir);
  if (seed) await loadSyntheticSuite(store);
  return store;
}

export interface TestLab {
  readonly store: LabStore;
  readonly app: Express;
  readonly agent: ReturnType<typeof request>;
}

export async function testLab(seed = true): Promise<TestLab> {
  const store = await freshStore(seed);
  const app = createApp({ store, csrf: CSRF });
  return { store, app, agent: request(app) };
}

/** A form post as the lab's own pages send it. */
export const post = (lab: TestLab, path: string, fields: Record<string, unknown> = {}): request.Test =>
  lab.agent.post(path).type('form').send({ _csrf: CSRF, ...fields });

export const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
