/** What every page handler needs: the store, the form token, and helpers for rendering and redirects. */
import type { Request, Response } from 'express';
import { ID_PATTERN } from '../domain/schemas.js';
import type { LabStore } from '../storage/store.js';
import { page, type NavKey, type SafeHtml, type Theme } from './html.js';
import { HTTP } from './status.js';

export interface AppContext {
  readonly store: LabStore;
  readonly csrf: string;
  /** Name recorded when the owner validates, freezes, scores or spot-checks. */
  readonly owner: string;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} was not found.`);
    this.name = 'NotFoundError';
  }
}

const THEME_COOKIE = 'theme';
const LIGHT: Theme = 'light';
const COOKIE_SEPARATOR = ';';
const PAIR_SEPARATOR = '=';
const DECIMAL = 10;

export function themeOf(req: Request): Theme {
  const cookies = (req.headers.cookie ?? '').split(COOKIE_SEPARATOR).map((c) => c.trim().split(PAIR_SEPARATOR));
  const value = cookies.find(([name]) => name === THEME_COOKIE)?.[1];
  // Dark is the default whatever the operating system prefers; light only when chosen.
  return value === LIGHT ? LIGHT : 'dark';
}

/** Fixed confirmation messages, chosen by key so no user text is ever echoed from the address bar. */
export const NOTICES = {
  'case-created': 'Candidate case created.',
  'case-saved': 'Changes saved.',
  'case-new-version': 'Saved as a new version. The earlier frozen version and its results are unchanged.',
  'case-validated': 'Case validated. Freeze it when you are ready to use it for evaluations.',
  'case-frozen': 'Case frozen. Its test conditions are now fixed.',
  'case-archived': 'Case archived. It is hidden from lists but kept with its history.',
  'case-restored': 'Case restored from the archive.',
  'cases-imported': 'Imported as candidate cases. Validate them before use.',
  'profile-saved': 'Profile saved as a new version. Earlier versions and their results are unchanged.',
  'output-added': 'Output saved.',
  'outputs-imported': 'Outputs imported.',
  'result-saved': 'Assessment saved.',
  'checks-run': 'Automatic checks finished.',
  'checks-same': 'These checks were already run on this output with identical results (they are reproducible).',
  'spot-accepted': 'Assessment accepted.',
  'spot-corrected': 'Your correction was saved. The reviewer’s original findings are kept beside it.',
  'spot-rejected': 'Assessment rejected. It will not count in any report.',
  'batch-accepted': 'The rest of the batch was accepted.',
  'comparison-created': 'Blind comparison created.',
  'comparison-recorded': 'Preference recorded. Identities are now revealed.',
  'comparison-rejected': 'The reviewer’s preference was rejected. Identities stay hidden until you record your own.',
  'observation-saved': 'Observation saved.',
  'observation-candidate': 'Candidate case created from the observation.',
  'observations-imported': 'Observations imported.',
  'synthetic-removed': 'Synthetic examples removed. Your own data was not touched.',
  'synthetic-loaded': 'Synthetic examples loaded.',
  'runner-imported': 'Test-runner results imported.',
} as const;
export type NoticeKey = keyof typeof NOTICES;

const noticeFor = (key: unknown): string | null => (typeof key === 'string' && Object.hasOwn(NOTICES, key) ? NOTICES[key as NoticeKey] : null); // key checked with hasOwn

export function redirectDone(res: Response, path: string, key: NoticeKey): void {
  const separator = path.includes('?') ? '&' : '?';
  res.redirect(HTTP.seeOther, `${path}${separator}done=${key}`);
}

export interface RenderOptions {
  readonly title: string;
  readonly intro: string;
  readonly active: NavKey;
  readonly body: SafeHtml;
}

export function render(req: Request, res: Response, ctx: AppContext, opts: RenderOptions, status: number = HTTP.ok): void {
  const reviewCount =
    ctx.store.snapshot().results.filter((r) => r.review.state === 'needs-spot-check').length +
    ctx.store.snapshot().comparisons.filter((c) => c.review.state === 'needs-spot-check').length;
  res
    .status(status)
    .type('html')
    .send(
      page({
        ...opts,
        theme: themeOf(req),
        csrf: ctx.csrf,
        notice: noticeFor(req.query['done']),
        reviewCount,
        currentPath: req.path,
      }).value,
    );
}

/** A route parameter that must be a record id; anything else is treated as "not found". */
export function idParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new NotFoundError('That page');
  return value;
}

export function versionParam(req: Request, name = 'version'): number {
  const value = Number.parseInt(String(req.params[name] ?? ''), DECIMAL);
  if (!Number.isInteger(value) || value < 1) throw new NotFoundError('That version');
  return value;
}

export const queryText = (req: Request, key: string): string => {
  const value = req.query[key];
  return typeof value === 'string' ? value.trim() : '';
};
