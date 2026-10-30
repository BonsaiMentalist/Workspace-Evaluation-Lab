/**
 * Keeps blind comparisons blind across the rest of the lab. Pages that would
 * show an output's text next to its model, label or findings first show a
 * warning while that output is in a comparison with no recorded preference;
 * the owner can still choose to continue.
 */
import type { Request, Response } from 'express';
import type { LabSnapshot } from '../domain/lookup.js';
import { findCase } from '../domain/lookup.js';
import { html, linkButton } from './html.js';
import { queryText, render, type AppContext } from './context.js';
import type { NavKey } from './html.js';

const REVEAL = 'reveal';
const YES = '1';

/** Outputs that appear in a comparison whose preference is not yet recorded. */
export function outputsInOpenComparisons(lab: LabSnapshot): ReadonlySet<string> {
  return new Set(lab.comparisons.filter((c) => c.status === 'open').flatMap((c) => c.entries.map((e) => e.outputId)));
}

/** Returns true when the page may be shown; otherwise renders the warning and returns false. */
export function passBlindGuard(req: Request, res: Response, ctx: AppContext, outputId: string, active: NavKey): boolean {
  const lab = ctx.store.snapshot();
  if (queryText(req, REVEAL) === YES || !outputsInOpenComparisons(lab).has(outputId)) return true;
  const comparison = lab.comparisons.find((c) => c.status === 'open' && c.entries.some((e) => e.outputId === outputId));
  const caseTitle = comparison ? (findCase(lab, comparison.caseId, comparison.caseVersion)?.title ?? comparison.caseId) : '';
  render(req, res, ctx, {
    title: 'This output is in an open blind comparison',
    intro: 'Opening this page would show which model wrote this output before you have recorded your blind preference.',
    active,
    body: html`<div class="alert alert-warn">The blind comparison for “${caseTitle}” has no recorded preference yet. Record it first to keep the comparison blind.</div>
      <div class="toolbar">${comparison ? linkButton(`/compare/${comparison.id}`, 'Go to the blind comparison', 'primary') : ''}
      ${linkButton(`${req.path}?${REVEAL}=${YES}`, 'Show this page anyway')}</div>`,
  });
  return false;
}
