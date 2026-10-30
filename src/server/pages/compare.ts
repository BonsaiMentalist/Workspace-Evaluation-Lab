/** Compare: blinded preferences between outputs, and the criterion-level report with comparability verdicts. */
import { Router, type Request, type RequestHandler } from 'express';
import type { BlindedComparison, Choice, SavedOutput, SpecialistProfile } from '../../domain/schemas.js';
import { Choice as ChoiceSchema } from '../../domain/schemas.js';
import { acceptImportedPreference, blindView, CHOICE_LABELS, createComparison, isRevealed, recordPreference, rejectImportedPreference } from '../../domain/comparisons.js';
import { compareOutputs, EQUIVALENCE_LABELS, equivalenceOf, type CriterionRow } from '../../domain/report.js';
import { canEvaluate, LifecycleError } from '../../domain/cases.js';
import { byNewest, findCase, findComparison, findOutput, findProfile, latestCases, outputsForCase, profileForCase } from '../../domain/lookup.js';
import { newId, nowIso } from '../../domain/hash.js';
import { ASSESSED_BY_LABELS } from '../../domain/scoring.js';
import { badge, button, empty, evaluatorTypeLabel, html, imageTag, linkButton, outcomeBadge, postForm, prose, reviewBadge, section, shortDate, sourceBadge, tip, type SafeHtml } from '../html.js';
import { bodyOf, longText, many, rows, text } from '../form.js';
import { idParam, NotFoundError, queryText, redirectDone, render, type AppContext } from '../context.js';
import { caseLink, modelLine, TIPS } from '../views.js';

const MIN_OUTPUTS = 2;
const DECIMAL = 10;
const SIGNIFICANCE_LABELS = { major: 'Practically significant', minor: 'Minor', none: 'No difference', unknown: 'Cannot tell' } as const;
const EQUIVALENCE_TONES = { equivalent: 'good', 'partially-equivalent': 'warn', 'not-comparable': 'bad' } as const;

const choiceLabel = (choice: Choice): string => (choice === 'tie' || choice === 'inconclusive' ? CHOICE_LABELS[choice] : `Output ${choice}`);

function preferenceView(profile: SpecialistProfile | undefined, preference: NonNullable<BlindedComparison['preference']>): SafeHtml {
  const name = (id: string): string => profile?.criteria.find((cr) => cr.id === id)?.name ?? id;
  return html`<p><strong>Overall: ${choiceLabel(preference.overall.choice)}.</strong> ${preference.overall.reason}</p>
    ${preference.perCriterion.length ? html`<ul>${preference.perCriterion.map((p) => html`<li>${name(p.criterionId)}: <strong>${choiceLabel(p.choice)}</strong>${p.reason ? ` — ${p.reason}` : ''}</li>`)}</ul>` : ''}`;
}

function preferenceForm(c: BlindedComparison, profile: SpecialistProfile | undefined, csrf: string): SafeHtml {
  const choices: Choice[] = [...c.entries.map((e) => e.label), 'tie', 'inconclusive'];
  const radios = (name: string, required: boolean): SafeHtml =>
    html`<div class="row radios">${choices.map((choice) => html`<label class="check"><input type="radio" name="${name}" value="${choice}"${required ? html` required` : ''}> ${choiceLabel(choice)}</label>`)}</div>`;
  const criteria = (profile?.criteria ?? []).filter((cr) => !c.criterionIds.length || c.criterionIds.includes(cr.id));
  return postForm(
    `/compare/${c.id}/record`,
    csrf,
    html`<fieldset><legend>Which output is better overall?</legend>${radios('overall', true)}<label>Reason (required) <textarea name="reason" rows="3" required></textarea></label></fieldset>
    <details><summary>Preference per criterion (optional)</summary>${criteria.map(
      (cr, i) => html`<fieldset class="criterion"><legend>${cr.name}</legend><input type="hidden" name="perCriterion[${i}][criterionId]" value="${cr.id}">
        <div class="row radios">${choices.map((choice) => html`<label class="check"><input type="radio" name="perCriterion[${i}][choice]" value="${choice}"> ${choiceLabel(choice)}</label>`)}</div>
        <label>Reason <input name="perCriterion[${i}][reason]"></label></fieldset>`,
    )}</details>
    ${button('Record preference and reveal')}`,
  );
}

function blindPage(c: BlindedComparison, outputs: readonly SavedOutput[], profile: SpecialistProfile | undefined, taskHtml: SafeHtml, csrf: string): SafeHtml {
  const view = blindView(c, outputs);
  const imported = c.importedPreference && c.review.state === 'needs-spot-check';
  return html`<div class="alert alert-info">Model, configuration and labels are hidden until a preference is recorded. ${tip(TIPS.blinded)} If an output names its own model in its text, this comparison is not fully blind.</div>
    ${section('Task', taskHtml)}
    <div class="grid-${view.entries.length > MIN_OUTPUTS ? '3' : '2'}">${view.entries.map(
      (e) => html`<article class="output-card blind"><header><h3>Output ${e.label}</h3></header>${prose(e.text)}${e.artifacts.map(
        (a) => html`<figure class="artifact"><figcaption>${badge('info', 'Tool output')}</figcaption>${a.image ? imageTag(a.image.store, a.image.name, a.image.alt) : prose(a.text)}</figure>`,
      )}</article>`,
    )}</div>
    ${
      imported && c.importedPreference && c.evaluator
        ? section(
            `The ${evaluatorTypeLabel(c.evaluator.type)}’s preference`,
            html`<p class="muted small">${c.evaluator.name}${c.evaluator.version ? ` (${c.evaluator.version})` : ''} · imported from ${c.provenance.sourceFile ?? 'a file'}</p>
            ${preferenceView(profile, c.importedPreference)}
            <div class="toolbar">${postForm(`/compare/${c.id}/accept-imported`, csrf, button('Accept this preference and reveal'), { cls: 'inline' })}
            ${postForm(`/compare/${c.id}/reject-imported`, csrf, html`<input name="note" placeholder="Why reject it?" required> ${button('Reject', 'danger')}`, { cls: 'inline' })}</div>
            <p class="muted small">Or record your own preference below; the reviewer’s is kept beside it.</p>`,
          )
        : ''
    }
    ${section('Your preference', preferenceForm(c, profile, csrf))}`;
}

function revealedPage(c: BlindedComparison, outputs: readonly SavedOutput[], profile: SpecialistProfile | undefined, ctx: AppContext): SafeHtml {
  const byId = new Map(outputs.map((o) => [o.id, o]));
  const results = ctx.store.snapshot().results.filter((r) => c.entries.some((e) => e.outputId === r.outputId));
  const equivalence = equivalenceOf(outputs, results);
  const decidedByState: Partial<Record<BlindedComparison['review']['state'], string>> = {
    corrected: `${c.review.decidedBy ?? 'Owner'} (replacing the imported preference)`,
    accepted: `${c.evaluator?.name ?? 'Reviewer'}, accepted by ${c.review.decidedBy ?? 'Owner'}`,
  };
  const decidedBy = decidedByState[c.review.state] ?? c.evaluator?.name ?? 'Owner';
  return html`${section(
    'Who was who',
    html`<div class="table-wrap"><table><thead><tr><th scope="col">Shown as</th><th scope="col">Output</th><th scope="col">Produced by</th></tr></thead><tbody>${c.entries.map((e) => {
      const o = byId.get(e.outputId);
      return html`<tr><td>Output ${e.label}</td><td>${o ? html`<a href="/outputs/${o.id}">${o.label}</a>` : e.outputId}</td><td>${o ? modelLine(o) : ''}</td></tr>`;
    })}</tbody></table></div>
    <p>${badge(EQUIVALENCE_TONES[equivalence.level], EQUIVALENCE_LABELS[equivalence.level])} ${tip(TIPS.equivalent)}</p><ul>${equivalence.reasons.map((r) => html`<li>${r}</li>`)}</ul>`,
  )}
  ${c.preference ? section('Recorded preference', html`${preferenceView(profile, c.preference)}<p class="muted small">Decided by ${decidedBy} ${reviewBadge(c.review.state)} on ${shortDate(c.recordedAt)}</p>`) : ''}
  ${c.importedPreference && c.review.state === 'corrected' ? section('The imported reviewer’s original preference', preferenceView(profile, c.importedPreference)) : ''}
  <div class="toolbar">${linkButton(`/compare/report?case=${c.caseId}&version=${c.caseVersion}&outputs=${c.entries.map((e) => e.outputId).join(',')}`, 'Criterion-level report', 'primary')}</div>`;
}

function rowCells(row: CriterionRow): SafeHtml {
  return html`${row.cells.map(
    (cell) =>
      html`<td>${cell.findings.length ? cell.findings.map((f) => html`<div>${outcomeBadge(f.finding.outcome)}${f.finding.rating ? ` ${f.finding.rating.value}/${f.finding.rating.max}` : ''} ${sourceBadge(f.source)}</div>`) : outcomeBadge('not-assessed')}</td>`,
  )}`;
}

export function compareRoutes(ctx: AppContext, csrfCheck: RequestHandler): Router {
  const router = Router();

  router.get('/compare', (req, res) => {
    const lab = ctx.store.snapshot();
    const comparisons = [...lab.comparisons].sort((a, b) => Number(isRevealed(a)) - Number(isRevealed(b)) || byNewest(a, b));
    const candidates = latestCases(lab).filter((c) => canEvaluate(c) && outputsForCase(lab, c.id, c.version).length >= MIN_OUTPUTS);
    const body = html`${section(
      'Start a blind comparison',
      candidates.length
        ? html`<form method="get" action="/compare/new" class="row"><label class="grow">Case <select name="case">${candidates.map((c) => html`<option value="${c.id}:${c.version}">${c.title} (${c.specialistId})</option>`)}</select></label> <button class="btn btn-primary" type="submit">Choose outputs</button></form>`
        : empty('No frozen case has two or more outputs yet.'),
    )}
    ${section(
      'Comparisons',
      comparisons.length
        ? html`<div class="table-wrap"><table><thead><tr><th scope="col">Case</th><th scope="col">Outputs</th><th scope="col">Status</th><th scope="col">Created</th></tr></thead><tbody>${comparisons.map((c) => {
            const testCase = findCase(lab, c.caseId, c.caseVersion);
            const waiting = c.review.state === 'needs-spot-check' ? badge('accent', 'Imported, awaiting you') : badge('accent', 'Awaiting preference');
            const status = isRevealed(c) ? badge('good', 'Preference recorded') : waiting;
            return html`<tr><td><a href="/compare/${c.id}">${testCase?.title ?? c.caseId}</a></td><td>${c.entries.length}</td><td>${status}</td><td>${shortDate(c.createdAt)}</td></tr>`;
          })}</tbody></table></div>`
        : empty('No comparisons yet.'),
    )}`;
    render(req, res, ctx, { title: 'Compare', intro: 'Compare outputs for the same case: blind preferences first, then criterion-by-criterion differences with a clear statement of how comparable they are.', active: 'compare', body });
  });

  router.get('/compare/new', (req, res) => {
    const [caseId = '', versionText = ''] = queryText(req, 'case').split(':');
    const c = findCase(ctx.store.snapshot(), caseId, Number.parseInt(versionText, DECIMAL));
    if (!c) throw new NotFoundError('That case');
    const lab = ctx.store.snapshot();
    const outputs = outputsForCase(lab, c.id, c.version);
    const profile = profileForCase(lab, c);
    const body = postForm(
      '/compare',
      ctx.csrf,
      html`<input type="hidden" name="caseId" value="${c.id}"><input type="hidden" name="caseVersion" value="${c.version}">
      <fieldset><legend>Outputs to compare</legend><p class="muted small">Outputs are listed by id and date only, so you don’t see which model made them.</p>
      ${outputs.map((o, i) => html`<label class="check"><input type="checkbox" name="outputIds" value="${o.id}" checked> Output saved ${shortDate(o.createdAt)} <span class="muted small">#${i + 1}</span></label>`)}</fieldset>
      <fieldset><legend>Criteria to give a preference on (optional)</legend>${(profile?.criteria ?? []).map((cr) => html`<label class="check"><input type="checkbox" name="criterionIds" value="${cr.id}"> ${cr.name}</label>`)}</fieldset>
      ${button('Start blind comparison')}`,
    );
    render(req, res, ctx, { title: `New comparison: ${c.title}`, intro: 'Choose which outputs to compare. They will be shown as A, B… in a random order.', active: 'compare', body });
  });

  router.post('/compare', csrfCheck, async (req, res) => {
    const body = bodyOf(req);
    const lab = ctx.store.snapshot();
    const c = findCase(lab, text(body, 'caseId'), Number.parseInt(text(body, 'caseVersion'), DECIMAL));
    if (!c || !canEvaluate(c)) throw new LifecycleError('Choose a frozen case');
    const profile = profileForCase(lab, c);
    if (!profile) throw new NotFoundError('The profile for this case');
    const outputIds = [...new Set(many(body, 'outputIds'))];
    const valid = outputIds.filter((id) => {
      const o = findOutput(lab, id);
      return o?.caseId === c.id && o.caseVersion === c.version;
    });
    if (valid.length < MIN_OUTPUTS) throw new LifecycleError('Choose at least two outputs of this case');
    const comparison = createComparison({
      id: newId('cmp'),
      caseId: c.id,
      caseVersion: c.version,
      profileId: profile.id,
      profileVersion: profile.version,
      outputIds: valid,
      criterionIds: many(body, 'criterionIds').filter((id) => profile.criteria.some((cr) => cr.id === id)),
      provenance: { origin: 'user', source: 'manual-entry', sourceFile: null, importedAt: null, note: '' },
    });
    await ctx.store.add('comparisons', comparison);
    redirectDone(res, `/compare/${comparison.id}`, 'comparison-created');
  });

  router.get('/compare/report', (req, res) => {
    const lab = ctx.store.snapshot();
    const c = findCase(lab, queryText(req, 'case'), Number.parseInt(queryText(req, 'version'), DECIMAL));
    if (!c) throw new NotFoundError('That case');
    const profile = profileForCase(lab, c);
    if (!profile) throw new NotFoundError('The profile for this case');
    const wanted = queryText(req, 'outputs').split(',').filter(Boolean);
    const all = outputsForCase(lab, c.id, c.version);
    const outputs = wanted.length ? all.filter((o) => wanted.includes(o.id)) : all;
    if (outputs.length < MIN_OUTPUTS) throw new LifecycleError('A report needs at least two outputs of the same case');
    const report = compareOutputs(profile, outputs, lab.results);
    const favours = (row: CriterionRow): string => {
      if (row.favours === 'unclear') return 'Cannot compare';
      if (row.favours === 'tie') return 'Tie';
      return row.favours.map((id) => outputs.find((o) => o.id === id)?.label ?? id).join(', ');
    };
    const blind = lab.comparisons.filter((cmp) => cmp.caseId === c.id && cmp.caseVersion === c.version && isRevealed(cmp));
    const body = html`<div class="toolbar">${caseLink(c)}</div>
      ${section(
        'Are these comparable?',
        html`<p>${badge(EQUIVALENCE_TONES[report.equivalence.level], EQUIVALENCE_LABELS[report.equivalence.level])} ${tip(TIPS.equivalent)}</p><ul>${report.equivalence.reasons.map((r) => html`<li>${r}</li>`)}</ul>
        <p class="small muted">Differences being compared: ${report.equivalence.differences.join(', ') || 'none recorded'}.</p>`,
      )}
      ${section(
        'Criterion by criterion',
        html`<div class="table-wrap"><table><thead><tr><th scope="col">Criterion</th>${outputs.map((o) => html`<th scope="col">${o.label}<div class="small muted">${modelLine(o)}</div></th>`)}<th scope="col">Favours</th><th scope="col">Difference</th></tr></thead>
        <tbody>${report.rows.map(
          (row) => html`<tr><td>${row.criterion.name}${row.criterion.mandatory ? html` ${badge('bad', 'Mandatory')}` : ''}${row.basis ? html`<div class="small muted">Compared using: ${ASSESSED_BY_LABELS[row.basis]}</div>` : ''}</td>${rowCells(row)}<td>${favours(row)}</td><td>${SIGNIFICANCE_LABELS[row.significance]}${row.note ? html`<div class="small muted">${row.note}</div>` : ''}</td></tr>`,
        )}</tbody></table></div>
        <p class="small">Criteria favouring each output: ${outputs.map((o) => html`<strong>${o.label}</strong> ${report.favouredCounts[o.id] ?? 0} `)}</p>`,
      )}
      ${section('What is uncertain', report.uncertain.length ? html`<ul>${report.uncertain.map((u) => html`<li>${u}</li>`)}</ul>` : html`<p>Every criterion could be compared.</p>`)}
      ${section('Is there enough evidence?', html`<p>${report.enoughObservations.message}</p>`)}
      ${section('Is a further experiment justified?', html`<p>${report.furtherExperiment.message}</p>`)}
      ${section(
        'Blind preferences for this case',
        blind.length ? html`<ul class="plain">${blind.map((b) => html`<li><a href="/compare/${b.id}">${shortDate(b.recordedAt)}</a>: ${b.preference ? choiceLabel(b.preference.overall.choice) : ''} ${b.preference?.overall.reason ?? ''}</li>`)}</ul>` : empty('None recorded.'),
      )}`;
    render(req, res, ctx, { title: `Report: ${c.title}`, intro: 'Which criteria favoured each output, how big the differences are, and how far the comparison can be trusted.', active: 'compare', body });
  });

  const load = (req: Request): BlindedComparison => {
    const c = findComparison(ctx.store.snapshot(), idParam(req, 'id'));
    if (!c) throw new NotFoundError('That comparison');
    return c;
  };

  router.get('/compare/:id', (req, res) => {
    const c = load(req);
    const lab = ctx.store.snapshot();
    const testCase = findCase(lab, c.caseId, c.caseVersion);
    const profile = findProfile(lab, c.profileId, c.profileVersion);
    const outputs = c.entries.flatMap((e) => findOutput(lab, e.outputId) ?? []);
    const taskHtml = testCase ? html`${prose(testCase.task)}<details><summary>What a good answer does</summary>${prose(testCase.expected.behaviour)}</details>` : html``;
    const body = isRevealed(c) ? revealedPage(c, outputs, profile, ctx) : blindPage(c, outputs, profile, taskHtml, ctx.csrf);
    render(req, res, ctx, {
      title: `${isRevealed(c) ? 'Comparison' : 'Blind comparison'}: ${testCase?.title ?? c.caseId}`,
      intro: isRevealed(c) ? 'The recorded preference and who produced each output.' : 'Read the outputs and choose which is better, with a reason, before identities are revealed.',
      active: 'compare',
      body,
    });
  });

  router.post('/compare/:id/record', csrfCheck, async (req, res) => {
    const c = load(req);
    const body = bodyOf(req);
    const perCriterion = rows(body, 'perCriterion').flatMap((row) => {
      const choice = ChoiceSchema.safeParse(text(row, 'choice'));
      return choice.success ? [{ criterionId: text(row, 'criterionId'), choice: choice.data, reason: text(row, 'reason') }] : [];
    });
    const preference = { overall: { choice: text(body, 'overall'), reason: longText(body, 'reason') }, perCriterion };
    await ctx.store.replace('comparisons', recordPreference(c, preference, { type: 'human', name: ctx.owner, version: null, date: nowIso() }));
    redirectDone(res, `/compare/${c.id}`, 'comparison-recorded');
  });

  router.post('/compare/:id/accept-imported', csrfCheck, async (req, res) => {
    const c = load(req);
    await ctx.store.replace('comparisons', acceptImportedPreference(c, ctx.owner));
    redirectDone(res, `/compare/${c.id}`, 'comparison-recorded');
  });

  router.post('/compare/:id/reject-imported', csrfCheck, async (req, res) => {
    const c = load(req);
    await ctx.store.replace('comparisons', rejectImportedPreference(c, ctx.owner, longText(bodyOf(req), 'note')));
    redirectDone(res, `/compare/${c.id}`, 'comparison-rejected');
  });

  return router;
}

