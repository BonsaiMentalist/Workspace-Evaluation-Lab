/**
 * Starts the lab: opens the local data folder (loading the synthetic examples
 * the first time), listens on localhost only, and opens the browser.
 * `--no-browser` skips opening the browser.
 */
import { createServer } from 'node:net';
import open from 'open';
import { LabStore } from '../storage/store.js';
import { loadSyntheticSuite } from '../seed/suite.js';
import { DEFAULT_DATA_DIR } from '../paths.js';
import { createApp } from './app.js';
import { DEFAULT_PORT, LISTEN_HOST as HOST } from './listen.js';

const PORTS_TO_TRY = 20;
const NO_BROWSER = '--no-browser';

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once('error', () => resolvePort(false));
    probe.once('listening', () => probe.close(() => resolvePort(true)));
    probe.listen(port, HOST);
  });
}

async function firstFreePort(start: number): Promise<number> {
  const candidates = Array.from({ length: PORTS_TO_TRY }, (_, i) => start + i);
  const found = await candidates.reduce<Promise<number | null>>(async (previous, port) => (await previous) ?? ((await portIsFree(port)) ? port : null), Promise.resolve(null));
  if (found === null) throw new Error(`No free port between ${start} and ${start + PORTS_TO_TRY - 1}. Set EVAL_LAB_PORT to another number.`);
  return found;
}

async function openBrowser(url: string): Promise<void> {
  try {
    await open(url);
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

async function main(): Promise<void> {
  const dataDir = process.env['EVAL_LAB_DATA_DIR'] || DEFAULT_DATA_DIR;
  const { store, created } = await LabStore.open(dataDir);
  if (created) {
    const seeded = await loadSyntheticSuite(store);
    console.log(`First start: loaded ${seeded.added} synthetic example records.`);
    seeded.problems.forEach((p) => console.warn(`Example data problem: ${p}`));
  }
  const port = await firstFreePort(Number(process.env['EVAL_LAB_PORT']) || DEFAULT_PORT);
  const app = createApp({ store, log: process.env['EVAL_LAB_LOG'] === '1' });
  app.listen(port, HOST, () => {
    const url = `http://localhost:${port}/`;
    console.log(`Specialist Evaluation Lab is running at ${url}`);
    console.log(`Your data is kept in ${store.dataDir}`);
    console.log('Press Ctrl+C to stop.');
    if (!process.argv.includes(NO_BROWSER)) void openBrowser(url);
  });
}

try {
  await main();
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : 'The lab could not start.');
  process.exit(1);
}
