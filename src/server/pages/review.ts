/** Spot-check: the owner accepts, corrects or rejects imported assessments, then may accept the rest of a batch together. */
import { Router, type Request, type RequestHandler } from 'express';
import type { EvaluationResult } from '../../domain/schemas.js';
import { acceptRemaining, acceptResult, batchProgress, correctResult, rejectResult } from '../../domain/imports.js';
import { byNewest, findBatch, findCase, findOutput, findProfile, findResult } from '../../domain/lookup.js';
import { LifecycleError } from '../../domain/cases.js';
import { nowIso } from '../../domain/hash.js';
import { badge, button, empty, evaluatorTypeLabel, html, linkButton, originBadge, postForm, prose, section, shortDateTime, tip } from '../html.js';
import { bodyOf, longText } from '../form.js';
import { idParam, NotFoundError, redirectDone, render, type AppContext } from '../context.js';
import { caseLink, findingsTable, outputBody, scoreSummaryView, TIPS } from '../views.js';
import { findingsFields, findingsFromForm } from './scoringForm.js';

export function reviewRoutes(ctx: AppContext, csrfCheck: RequestHandler): Router {
  const router = Router();

  router.get('/review', (req, res) => {
    const lab = ctx.store.snapshot();
    const batches = [...lab.importBatches].sort((a, b) => b.importedAt.localeCompare(a.importedAt));
    const titleOf = (r: EvaluationResult): string => findCase(lab, r.caseId, r.caseVersion)?.title ?? r.caseId;
    const batchCards = batches.map((b) => {
      const progress = batchProgress(b, lab);
      const pending = lab.results.filter((r) => r.importRef?.batchId === b.id && r.review.state === 'needs-spot-check');
      const comparisons = lab.comparisons.filter((c) => c.importRef?.batchId === b.id && c.review.state === 'needs-spot-check');
      return section(
        `Batch ${b.id}`,
        html`<p>${evaluatorTypeLabel(b.evaluator.type)} <strong>${b.evaluator.name}</strong>${b.evaluator.version ? ` (${b.evaluator.version})` : ''} · file ${b.sourceFile ?? 'unknown'} · imported ${shortDateTime(b.importedAt)} ${originBadge(b.origin)}</p>
        ${
          b.evaluator.type === 'ai-reviewer'
            ? html`<p>${progress.total} assessment(s): ${progress.pending} awaiting a spot-check. You have checked ${progress.reviewedIndividually} one by one; at least ${progress.sampleRequired} are needed before the rest can be accepted together. ${tip(TIPS.spotCheck)}</p>`
            : html`<p>Assessments by a person do not need a spot-check.</p>`
        }
        ${pending.length ? html`<div class="table-wrap"><table><thead><tr><th scope="col">Case</th><th scope="col">Output</th><th scope="col"></th></tr></thead><tbody>${pending.map((r) => html`<tr><td>${titleOf(r)}</td><td>${findOutput(lab, r.outputId)?.label ?? r.outputId}</td><td>${linkButton(`/review/${r.id}`, 'Spot-check', 'primary')}</td></tr>`)}</tbody></table></div>` : ''}
        ${comparisons.length ? html`<p>Blind comparisons from this batch awaiting your decision: ${comparisons.map((c) => html`<a href="/compare/${c.id}">${findCase(lab, c.caseId, c.caseVersion)?.title ?? c.caseId}</a> `)} ${tip(TIPS.blinded)}</p>` : ''}
        ${progress.canAcceptRest ? postForm(`/review/batch/${b.id}/accept-rest`, ctx.csrf, button(`Accept the remaining ${progress.pending}`, 'secondary')) : ''}
        ${b.rejected.length ? html`<div class="alert alert-warn"><strong>Entries rejected on import (never stored):</strong><ul>${b.rejected.map((r) => html`<li>${r.message}</li>`)}</ul></div>` : ''}`,
      );
    });
    const decided = lab.results.filter((r) => r.importRef && r.review.state !== 'needs-spot-check' && r.review.state !== 'not-required').sort(byNewest);
    const body = html`${batchCards.length ? batchCards : empty('No imported assessments yet. Import a batch on the Evaluate page.')}
      ${decided.length ? section('Already decided', html`<ul class="plain">${decided.map((r) => html`<li><a href="/results/${r.id}">${titleOf(r)}</a> · ${findOutput(lab, r.outputId)?.label ?? r.outputId} · ${badge(r.review.state === 'rejected' ? 'bad' : 'good', r.review.state)}${r.review.via === 'batch' ? ' (with the batch)' : ''}</li>`)}</ul>`) : ''}`;
    render(req, res, ctx, { title: 'Spot-check', intro: 'Assessments imported from an AI reviewer wait here until you accept, correct or reject them; only then do they count.', active: 'review', body });
  });

  const load = (req: Request): EvaluationResult => {
    const r = findResult(ctx.store.snapshot(), idParam(req, 'id'));
    if (!r) throw new NotFoundError('That assessment');
    return r;
  };

  router.get('/review/:id', (req, res) => {
    const r = load(req);
    const lab = ctx.store.snapshot();
    const profile = findProfile(lab, r.profileId, r.profileVersion);
    const testCase = findCase(lab, r.caseId, r.caseVersion);
    const output = findOutput(lab, r.outputId);
    if (!profile || !testCase || !output) throw new NotFoundError('The case, output or profile for this assessment');
    const pending = r.review.state === 'needs-spot-check';
    const body = html`<div class="toolbar">${caseLink(testCase)} ${badge('accent', `${evaluatorTypeLabel(r.evaluator.type)}: ${r.evaluator.name}${r.evaluator.version ? ` (${r.evaluator.version})` : ''}`)} <span class="muted small">from ${r.provenance.sourceFile ?? 'unknown file'}</span></div>
      ${pending ? '' : html`<div class="alert alert-good">Already decided: ${r.review.state}. ${linkButton(`/results/${r.id}`, 'View result')}</div>`}
      <div class="split-view">
        <div>${section('Output', outputBody(output))}
          ${section('What a good answer does', html`${prose(testCase.expected.behaviour)}<ul>${testCase.expected.acceptanceCriteria.map((a) => html`<li>${a}</li>`)}</ul>`)}</div>
        <div>${section('The reviewer’s assessment', html`${scoreSummaryView(profile, r.findings)}${findingsTable(profile, r.findings)}${r.overallNote ? prose(r.overallNote) : ''}`)}
          ${
            pending
              ? html`${section(
                  'Your decision',
                  html`${postForm(`/review/${r.id}/accept`, ctx.csrf, button('Accept as it is'))}
                  ${postForm(`/review/${r.id}/reject`, ctx.csrf, html`<label>Why reject it? <input name="note" required></label>${button('Reject', 'danger')}`)}`,
                )}
                ${section(
                  'Or correct it',
                  postForm(
                    `/review/${r.id}/correct`,
                    ctx.csrf,
                    html`<p class="muted small">Change any finding. The reviewer’s original findings are kept beside yours.</p>${findingsFields(profile, r.findings)}<label>Note about your correction <input name="note"></label>${button('Save correction')}`,
                  ),
                )}`
              : ''
          }</div>
      </div>`;
    render(req, res, ctx, { title: `Spot-check: ${testCase.title}`, intro: 'Look at the output and the reviewer’s findings, then accept, correct or reject them.', active: 'review', body });
  });

  router.post('/review/:id/accept', csrfCheck, async (req, res) => {
    const saved = await ctx.store.replace('results', acceptResult(load(req), ctx.owner, nowIso()));
    redirectDone(res, nextPending(saved), 'spot-accepted');
  });

  router.post('/review/:id/reject', csrfCheck, async (req, res) => {
    const note = longText(bodyOf(req), 'note');
    if (!note) throw new LifecycleError('Say briefly why you are rejecting this assessment');
    const saved = await ctx.store.replace('results', rejectResult(load(req), ctx.owner, note, nowIso()));
    redirectDone(res, nextPending(saved), 'spot-rejected');
  });

  router.post('/review/:id/correct', csrfCheck, async (req, res) => {
    const r = load(req);
    const profile = findProfile(ctx.store.snapshot(), r.profileId, r.profileVersion);
    if (!profile) throw new NotFoundError('The profile for this assessment');
    const body = bodyOf(req);
    const saved = await ctx.store.replace('results', correctResult(r, findingsFromForm(body, profile), profile, ctx.owner, longText(body, 'note'), nowIso()));
    redirectDone(res, `/results/${saved.id}`, saved.review.state === 'corrected' ? 'spot-corrected' : 'spot-accepted');
  });

  router.post('/review/batch/:id/accept-rest', csrfCheck, async (req, res) => {
    const batch = findBatch(ctx.store.snapshot(), idParam(req, 'id'));
    if (!batch) throw new NotFoundError('That batch');
    const accepted = acceptRemaining(batch, ctx.store.snapshot(), ctx.owner, nowIso());
    await accepted.reduce(async (previous, r) => {
      await previous;
      await ctx.store.replace('results', r);
    }, Promise.resolve());
    redirectDone(res, '/review', 'batch-accepted');
  });

  /** After a decision, go to the next assessment of the same batch still awaiting a spot-check, if any. */
  const nextPending = (decided: EvaluationResult): string => {
    const next = ctx.store.snapshot().results.find((r) => r.importRef?.batchId === decided.importRef?.batchId && r.review.state === 'needs-spot-check');
    return next ? `/review/${next.id}` : '/review';
  };

  return router;
}

