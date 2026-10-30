/** Production observations: things noticed in real use. They can suggest a candidate case but never prove a general weakness. */
import { Router, type RequestHandler } from 'express';
import type { Multer } from 'multer';
import { z } from 'zod';
import type { ProductionObservation } from '../../domain/schemas.js';
import { FORMAT_VERSION, ProductionObservation as ObservationSchema } from '../../domain/schemas.js';
import { byNewest, findObservation, latestCase, latestProfiles } from '../../domain/lookup.js';
import { LifecycleError } from '../../domain/cases.js';
import { describeZodError } from '../../domain/errors.js';
import { newId, nowIso } from '../../domain/hash.js';
import { badge, button, definitionList, empty, html, known, linkButton, originBadge, postForm, prose, section, shortDate, type SafeHtml } from '../html.js';
import { bodyOf, longText, text } from '../form.js';
import { idParam, NotFoundError, redirectDone, render, type AppContext } from '../context.js';

const TYPE_LABELS = { success: 'Success', failure: 'Failure', correction: 'Correction', review: 'Review', other: 'Other' } as const;
const INVESTIGATION_LABELS = { 'not-yet': 'Not investigated yet', investigating: 'Being investigated', investigated: 'Investigated' } as const;
const MAX_IMPORT = 1000;
const FILE_NAME_MAX = 200;

const option = (value: string, label: string, current: string): SafeHtml => html`<option value="${value}"${value === current ? html` selected` : ''}>${label}</option>`;

export function observationRoutes(ctx: AppContext, jsonUpload: Multer, csrfCheck: RequestHandler): ReturnType<typeof Router> {
  const router = Router();

  router.get('/observations', (req, res) => {
    const lab = ctx.store.snapshot();
    const list = [...lab.observations].sort(byNewest);
    const body = html`
      <div class="alert alert-info">An observation is evidence that something happened once. It may suggest a case worth testing, but on its own it does not show a general strength or weakness, or its cause.</div>
      ${section(
        'Observations',
        list.length
          ? html`<div class="table-wrap"><table><thead><tr><th scope="col">What happened</th><th scope="col">Type</th><th scope="col">Specialist / model</th><th scope="col">Confidence</th><th scope="col">Investigation</th><th scope="col">Candidate case</th></tr></thead><tbody>${list.map(
              (o) => html`<tr><td><a href="/observations/${o.id}">${o.whatHappened.slice(0, FILE_NAME_MAX)}</a> ${originBadge(o.provenance.origin)}</td><td>${TYPE_LABELS[o.type]}</td>
              <td>${known(o.specialistId)}<div class="small muted">${o.model.model ?? ''}</div></td><td>${o.confidence}</td><td>${INVESTIGATION_LABELS[o.investigation]}</td>
              <td>${o.candidateCaseId ? html`<a href="/cases/${o.candidateCaseId}">${o.candidateCaseId}</a>` : '—'}</td></tr>`,
            )}</tbody></table></div>`
          : empty('No observations yet.'),
      )}
      ${section(
        'Record an observation',
        postForm(
          '/observations',
          ctx.csrf,
          html`<div class="row"><label>Type <select name="type">${(Object.keys(TYPE_LABELS) as Array<keyof typeof TYPE_LABELS>).map((t) => option(t, TYPE_LABELS[t], 'failure'))}</select></label>
          <label>Where you noticed it <input name="source" required placeholder="e.g. a chat with Master"></label>
          <label>Specialist <select name="specialistId">${option('', 'Unknown', '')}${latestProfiles(lab).map((p) => option(p.id, p.name, ''))}</select></label>
          <label>Model, if known <input name="model"></label></div>
          <label>What happened <textarea name="whatHappened" rows="3" required></textarea></label>
          <label>Supporting evidence <textarea name="evidence" rows="2"></textarea></label>
          <div class="row"><label>Confidence <select name="confidence">${option('unknown', 'Unknown', 'unknown')}${option('low', 'Low', '')}${option('medium', 'Medium', '')}${option('high', 'High', '')}</select></label>
          <label class="grow">Uncertainty <input name="uncertaintyNote"></label></div>
          ${button('Save observation')}`,
        ),
      )}
      ${section(
        'Import observations',
        postForm('/observations/import', ctx.csrf, html`<p class="muted small">A JSON list of records in the production-observation format.</p><input type="file" name="file" accept="application/json,.json" required> ${button('Import', 'secondary')}`, { multipart: true }),
      )}`;
    render(req, res, ctx, { title: 'Observations', intro: 'Successes, failures and corrections noticed in real use, kept separate from validated test cases.', active: 'observations', body });
  });

  router.post('/observations', csrfCheck, async (req, res) => {
    const body = bodyOf(req);
    const parsed = ObservationSchema.safeParse({
      schema: 'eval-lab/production-observation',
      schemaVersion: FORMAT_VERSION,
      id: newId('obs'),
      type: text(body, 'type'),
      source: text(body, 'source'),
      specialistId: text(body, 'specialistId') || null,
      model: { model: text(body, 'model') || null },
      whatHappened: longText(body, 'whatHappened'),
      evidence: longText(body, 'evidence'),
      confidence: text(body, 'confidence') || 'unknown',
      uncertaintyNote: text(body, 'uncertaintyNote'),
      provenance: { origin: 'user', source: 'manual-entry' },
      privacy: 'local-private',
      createdAt: nowIso(),
    });
    if (!parsed.success) throw new LifecycleError(`The observation could not be saved. ${describeZodError(parsed.error)}`);
    await ctx.store.add('observations', parsed.data);
    redirectDone(res, `/observations/${parsed.data.id}`, 'observation-saved');
  });

  router.post('/observations/import', jsonUpload.single('file'), csrfCheck, async (req, res) => {
    const file = req.file;
    if (!file) throw new LifecycleError('Choose a JSON file to import');
    const list = z.array(z.unknown()).max(MAX_IMPORT).parse(JSON.parse(file.buffer.toString('utf8')));
    const lab = ctx.store.snapshot();
    const outcomes = list.map((raw, i): ProductionObservation | string => {
      const parsed = ObservationSchema.safeParse(raw, { reportInput: true });
      if (!parsed.success) return `Observation ${i + 1}: ${describeZodError(parsed.error)}`;
      if (findObservation(lab, parsed.data.id)) return `Observation ${i + 1} ("${parsed.data.id}") already exists.`;
      return { ...parsed.data, provenance: { origin: 'user', source: 'file-import', sourceFile: file.originalname.slice(0, FILE_NAME_MAX), importedAt: nowIso(), note: '' } };
    });
    const accepted = outcomes.filter((o): o is ProductionObservation => typeof o !== 'string');
    await ctx.store.addMany('observations', accepted);
    const problems = outcomes.filter((o): o is string => typeof o === 'string');
    render(req, res, ctx, {
      title: 'Import observations',
      intro: 'The result of importing observations from a file.',
      active: 'observations',
      body: html`<p>${accepted.length} observation(s) imported.</p>${problems.length ? html`<div class="alert alert-warn"><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}${linkButton('/observations', 'Back to observations', 'primary')}`,
    });
  });

  router.get('/observations/:id', (req, res) => {
    const o = findObservation(ctx.store.snapshot(), idParam(req, 'id'));
    if (!o) throw new NotFoundError('That observation');
    const candidate = o.candidateCaseId ? latestCase(ctx.store.snapshot(), o.candidateCaseId) : undefined;
    const body = html`<div class="toolbar">${badge('info', TYPE_LABELS[o.type])} ${originBadge(o.provenance.origin)}</div>
      ${section('What happened', prose(o.whatHappened))}
      ${section('Supporting evidence', prose(o.evidence))}
      ${section(
        'Details',
        definitionList([
          ['Noticed in', o.source],
          ['Observed', shortDate(o.observedAt)],
          ['Specialist', known(o.specialistId)],
          ['Model', known(o.model.model)],
          ['Workspace job / reply', known(o.workspace.job ?? o.workspace.reply)],
          ['Confidence', o.confidence],
          ['Uncertainty', o.uncertaintyNote || null],
        ]),
      )}
      ${section(
        'Candidate case',
        candidate
          ? html`<p>Linked to <a href="/cases/${candidate.id}">${candidate.title}</a>. The case stays separate from this observation and needs validating before it counts.</p>`
          : html`<p>If this deserves a proper test, turn it into a candidate case. The case must be validated before it is used.</p>${linkButton(`/cases/new?observation=${o.id}`, 'Create candidate case from this', 'primary')}`,
      )}
      ${section(
        'Investigation',
        postForm(
          `/observations/${o.id}/investigation`,
          ctx.csrf,
          html`<label>Status <select name="investigation">${(Object.keys(INVESTIGATION_LABELS) as Array<keyof typeof INVESTIGATION_LABELS>).map((k) => option(k, INVESTIGATION_LABELS[k], o.investigation))}</select></label>
          <label>Notes (what was checked; avoid conclusions a single observation cannot support) <textarea name="investigationNote" rows="3">${o.investigationNote}</textarea></label>${button('Save', 'secondary')}`,
        ),
      )}`;
    render(req, res, ctx, { title: 'Observation', intro: 'One thing noticed in real use, its evidence, and whether it has been looked into.', active: 'observations', body });
  });

  router.post('/observations/:id/investigation', csrfCheck, async (req, res) => {
    const o = findObservation(ctx.store.snapshot(), idParam(req, 'id'));
    if (!o) throw new NotFoundError('That observation');
    const body = bodyOf(req);
    const investigation = (['not-yet', 'investigating', 'investigated'] as const).find((s) => s === text(body, 'investigation')) ?? o.investigation;
    await ctx.store.replace('observations', { ...o, investigation, investigationNote: longText(body, 'investigationNote') });
    redirectDone(res, `/observations/${o.id}`, 'observation-saved');
  });

  return router;
}
