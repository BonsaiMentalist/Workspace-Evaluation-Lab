import { Router } from 'express';
import { byNewest, findCase, latestCases, latestProfiles } from '../../domain/lookup.js';
import { badge, empty, html, linkButton, section, shortDate } from '../html.js';
import { render, type AppContext } from '../context.js';
import { caseLink, resultsTable, TIPS } from '../views.js';
import { tip } from '../html.js';

const RECENT = 8;
const WAITING = 6;

export function overviewRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/', (req, res) => {
    const lab = ctx.store.snapshot();
    const cases = latestCases(lab).filter((c) => !c.archived);
    const candidates = cases.filter((c) => c.status === 'candidate');
    const validated = cases.filter((c) => c.status === 'validated');
    const pendingResults = lab.results.filter((r) => r.review.state === 'needs-spot-check');
    const pendingComparisons = lab.comparisons.filter((c) => c.status === 'open');
    const recent = [...lab.results].sort(byNewest).slice(0, RECENT);
    const titleOf = (caseId: string, version: number): string => findCase(lab, caseId, version)?.title ?? caseId;

    const waiting = html`<div class="grid-4">
      <a class="stat" href="/cases?status=candidate"><span class="stat-num">${candidates.length}</span><span>cases awaiting validation</span></a>
      <a class="stat" href="/cases?status=validated"><span class="stat-num">${validated.length}</span><span>validated cases not yet frozen ${tip(TIPS.frozen)}</span></a>
      <a class="stat" href="/review"><span class="stat-num">${pendingResults.length}</span><span>imported assessments awaiting your spot-check ${tip(TIPS.spotCheck)}</span></a>
      <a class="stat" href="/compare"><span class="stat-num">${pendingComparisons.length}</span><span>blind comparisons awaiting a preference ${tip(TIPS.blinded)}</span></a>
    </div>
    ${candidates.length ? html`<h3>Cases awaiting validation</h3><ul class="plain">${candidates.slice(0, WAITING).map((c) => html`<li>${caseLink(c)} <span class="muted small">${c.specialistId}</span></li>`)}</ul>` : ''}`;

    const specialists = latestProfiles(lab).map((p) => {
      const mine = cases.filter((c) => c.specialistId === p.id);
      const evaluable = mine.filter((c) => c.status === 'frozen' || c.status === 'evaluated');
      const results = lab.results.filter((r) => r.profileId === p.id).length;
      return html`<tr><td><a href="/profiles/${p.id}">${p.name}</a></td><td>${mine.length}</td><td>${evaluable.length}</td><td>${lab.outputs.filter((o) => mine.some((c) => c.id === o.caseId)).length}</td><td>${results}</td></tr>`;
    });

    const comparisons = [...lab.comparisons].sort(byNewest).slice(0, WAITING);
    const body = html`
      ${section('Waiting for you', waiting)}
      ${section(
        'Recent evaluations',
        resultsTable(recent, (r) => titleOf(r.caseId, r.caseVersion), 'No evaluations yet. Start on the Evaluate page.'),
        linkButton('/history', 'All history'),
      )}
      ${section(
        'Comparisons',
        comparisons.length
          ? html`<ul class="plain">${comparisons.map(
              (c) => html`<li><a href="/compare/${c.id}">${titleOf(c.caseId, c.caseVersion)}</a> · ${c.entries.length} outputs · ${c.status === 'open' ? badge('accent', 'Awaiting preference') : badge('good', 'Recorded')} <span class="muted small">${shortDate(c.createdAt)}</span></li>`,
            )}</ul>`
          : empty('No comparisons yet.'),
        linkButton('/compare', 'Compare'),
      )}
      ${section(
        'Library at a glance',
        html`<div class="table-wrap"><table><thead><tr><th scope="col">Specialist</th><th scope="col">Cases</th><th scope="col">Ready to evaluate</th><th scope="col">Saved outputs</th><th scope="col">Results</th></tr></thead><tbody>${specialists}</tbody></table></div>`,
      )}`;
    render(req, res, ctx, { title: 'Overview', intro: 'What needs your attention, and what has been evaluated recently.', active: 'overview', body });
  });
  return router;
}
