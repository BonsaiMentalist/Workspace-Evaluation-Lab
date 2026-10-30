/** History: past evaluations, grouped by specialist, model and configuration, with comparability warnings. */
import { Router } from 'express';
import { historyGroups, historyRows, type HistoryRow } from '../../domain/report.js';
import { latestProfiles } from '../../domain/lookup.js';
import { ASSESSED_BY_LABELS, OVERALL_LABELS, type AssessedBy } from '../../domain/scoring.js';
import type { OverallStatus } from '../../domain/schemas.js';
import { badge, empty, html, known, overallBadge, section, shortDate, sourceBadge, tip, type SafeHtml } from '../html.js';
import { queryText, render, type AppContext } from '../context.js';
import { TIPS } from '../views.js';

type SortKey = 'date' | 'specialist' | 'model' | 'case' | 'outcome' | 'source';

const OUTCOME_ORDER: readonly OverallStatus[] = ['critical-failure', 'fail', 'pass-with-issues', 'inconclusive', 'incomplete', 'pass'];

const SORTERS = {
  date: (a, b) => a.result.createdAt.localeCompare(b.result.createdAt),
  specialist: (a, b) => a.specialistId.localeCompare(b.specialistId),
  model: (a, b) => (a.result.model.model ?? '').localeCompare(b.result.model.model ?? ''),
  case: (a, b) => a.caseTitle.localeCompare(b.caseTitle),
  outcome: (a, b) => OUTCOME_ORDER.indexOf(a.result.overall ?? 'incomplete') - OUTCOME_ORDER.indexOf(b.result.overall ?? 'incomplete'),
  source: (a, b) => a.source.localeCompare(b.source),
} as const satisfies Record<SortKey, (a: HistoryRow, b: HistoryRow) => number>;

const COLUMNS: ReadonlyArray<readonly [SortKey, string]> = [
  ['date', 'Recorded'],
  ['specialist', 'Specialist'],
  ['case', 'Case'],
  ['model', 'Model and configuration'],
  ['source', 'Assessed by'],
  ['outcome', 'Outcome'],
];

const isSortKey = (value: string): value is SortKey => Object.hasOwn(SORTERS, value);

export function historyRoutes(ctx: AppContext): ReturnType<typeof Router> {
  const router = Router();
  router.get('/history', (req, res) => {
    const lab = ctx.store.snapshot();
    const requested = queryText(req, 'sort');
    const sort: SortKey = isSortKey(requested) ? requested : 'date';
    const ascending = queryText(req, 'dir') === 'asc';
    const specialist = queryText(req, 'specialist');
    const source = queryText(req, 'source');
    const all = historyRows(lab);
    const rows = all
      .filter((r) => !specialist || r.specialistId === specialist)
      .filter((r) => !source || r.source === source)
      .sort((a, b) => (ascending ? SORTERS[sort](a, b) : SORTERS[sort](b, a)));
    const groups = historyGroups(rows);
    const query = (key: SortKey): string => {
      const dir = key === sort && !ascending ? 'asc' : 'desc';
      return `/history?sort=${key}&dir=${dir}${specialist ? `&specialist=${encodeURIComponent(specialist)}` : ''}${source ? `&source=${encodeURIComponent(source)}` : ''}`;
    };
    const arrow = (key: SortKey): string => {
      if (key !== sort) return '';
      return ascending ? ' ▲' : ' ▼';
    };
    const sources = [...new Set(all.map((r) => r.source))];
    const option = (value: string, label: string, current: string): SafeHtml => html`<option value="${value}"${value === current ? html` selected` : ''}>${label}</option>`;

    const groupTable = groups.length
      ? html`<div class="table-wrap"><table><thead><tr><th scope="col">Specialist</th><th scope="col">Model</th><th scope="col">Configuration</th><th scope="col">Cases</th><th scope="col">Outcomes (counts)</th><th scope="col">Warnings</th></tr></thead><tbody>${groups.map(
          (g) => html`<tr><td>${g.specialistId}</td><td>${known(g.model)}</td><td>${known(g.configurationId)}</td><td>${g.cases} (${g.results} results)</td>
          <td>${Object.entries(g.outcomeCounts).map(([o, n]) => html`<div>${OVERALL_LABELS[o as OverallStatus] ?? o}: ${n}</div>`)}</td>
          <td>${g.warnings.length ? html`<ul class="small">${g.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : badge('good', 'None')}</td></tr>`,
        )}</tbody></table></div>`
      : empty('No results to group.');

    const body = html`
      <form method="get" action="/history" class="filters">
        <label>Specialist <select name="specialist">${option('', 'All', specialist)}${latestProfiles(lab).map((p) => option(p.id, p.name, specialist))}</select></label>
        <label>Assessed by <select name="source">${option('', 'All', source)}${sources.map((s) => option(s, ASSESSED_BY_LABELS[s as AssessedBy], source))}</select></label>
        <input type="hidden" name="sort" value="${sort}"><button class="btn btn-secondary" type="submit">Filter</button>
      </form>
      ${section(
        'By specialist, model and configuration',
        html`<p class="muted small">Counts, not percentages: a handful of cases can show a difference but not establish a pattern. Imported assessments awaiting spot-check and rejected ones are not included. ${tip(TIPS.spotCheck)}</p>${groupTable}`,
      )}
      ${section(
        'Every result',
        rows.length
          ? html`<div class="table-wrap"><table><thead><tr>${COLUMNS.map(([key, label]) => html`<th scope="col"><a href="${query(key)}">${label}${arrow(key)}</a></th>`)}<th scope="col">Comparability</th></tr></thead><tbody>${rows.map(
              (r) => html`<tr><td class="nowrap"><a href="/results/${r.result.id}">${shortDate(r.result.createdAt)}</a></td><td>${r.specialistId}</td><td>${r.caseTitle} <span class="muted small">v${r.result.caseVersion}</span></td>
              <td>${known(r.result.model.model)}<div class="small muted">${r.result.configuration.configurationId ?? ''} · rubric v${r.result.profileVersion}</div></td><td>${sourceBadge(r.source)}</td><td>${overallBadge(r.result.overall)}</td>
              <td>${r.warnings.length ? html`<ul class="small">${r.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : ''}</td></tr>`,
            )}</tbody></table></div>`
          : empty('No results yet.'),
      )}`;
    render(req, res, ctx, {
      title: 'History',
      intro: 'Past evaluations over time, so you can see how models and configurations fared, with a warning wherever results are not directly comparable.',
      active: 'history',
      body,
    });
  });
  return router;
}
