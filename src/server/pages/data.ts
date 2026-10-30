/** Settings / Data: where data lives, privacy protections, import/export, formats, theme and the synthetic examples. */
import { Router, type RequestHandler } from 'express';
import type { Multer } from 'multer';
import { buildBundle, importBundle, resultsCsv } from '../../domain/bundle.js';
import { FORMAT_NAMES, isFormatName, jsonSchemaFor, type FormatName } from '../../domain/jsonSchemas.js';
import { LifecycleError } from '../../domain/cases.js';
import { nowIso } from '../../domain/hash.js';
import { COLLECTIONS, type Collection } from '../../storage/store.js';
import { loadSyntheticSuite } from '../../seed/suite.js';
import { button, html, linkButton, postForm, section, type SafeHtml } from '../html.js';
import { bodyOf, checkbox } from '../form.js';
import { NotFoundError, redirectDone, render, themeOf, type AppContext } from '../context.js';
import { noteEvaluated } from './evaluate.js';

const FORMAT_DESCRIPTIONS = {
  'specialist-profile': 'A specialist’s criteria (one version).',
  'evaluation-case': 'An evaluation case (one version).',
  'saved-output': 'A saved output of a model or specialist for one case version.',
  'evaluation-result': 'An assessment of one output, with criterion findings and provenance.',
  'criterion-finding': 'One criterion’s finding inside a result.',
  'blinded-comparison': 'A blind comparison and its recorded preference.',
  'imported-assessment-batch': 'A file of assessments made elsewhere (AI reviewer or person).',
  'imported-assessment-entry': 'One assessment inside an imported batch.',
  'imported-comparison-entry': 'One blind comparison inside an imported batch.',
  'production-observation': 'Something noticed in real use.',
  'executable-report': 'Results written by a local test runner.',
  'model-descriptor': 'Model, provider and effort (Workspace registry ids).',
  'configuration-descriptor': 'Specialist, context and tool configuration ids.',
  'workspace-join-keys': 'Workspace job, piece, reply and chat ids, used to join with Workspace Analytics.',
  'resource-measurements': 'Tokens, duration and steps, where known (unknown is blank, never zero).',
  'export-bundle': 'Everything in the lab, as written by “Export everything”.',
} as const satisfies Record<FormatName, string>;

const COLLECTION_LABELS = {
  profiles: 'Profile versions',
  cases: 'Case versions',
  outputs: 'Saved outputs',
  results: 'Results',
  comparisons: 'Comparisons',
  observations: 'Observations',
  importBatches: 'Import batches',
} as const satisfies Record<Collection, string>;

const JSON_INDENT = 2;
const SYNTHETIC = 'synthetic';
const DATE_LENGTH = 10;
const JSON_SUFFIX = '.json';

function originOf(record: unknown): string {
  const r = record as { origin?: string; provenance?: { origin?: string } }; // origin sits at the top for profiles and batches, in provenance elsewhere
  return r.provenance?.origin ?? r.origin ?? 'user';
}

export function dataRoutes(ctx: AppContext, jsonUpload: Multer, csrfCheck: RequestHandler): ReturnType<typeof Router> {
  const router = Router();

  router.get('/data', (req, res) => {
    const lab = ctx.store.snapshot();
    const counts = COLLECTIONS.map((c) => {
      const list = lab[c] as readonly unknown[];
      const synthetic = list.filter((r) => originOf(r) === SYNTHETIC).length;
      return html`<tr><td>${COLLECTION_LABELS[c]}</td><td>${list.length - synthetic}</td><td>${synthetic}</td></tr>`;
    });
    const formats: SafeHtml[] = FORMAT_NAMES.map((name) => html`<tr><td><a href="/schemas/${name}.json"><code>${name}</code></a></td><td>${FORMAT_DESCRIPTIONS[name]}</td></tr>`);
    const theme = themeOf(req);
    const body = html`
      ${section(
        'Where your data lives',
        html`<p>Everything is stored in this folder on your computer:</p><p><code>${ctx.store.dataDir}</code></p>
        <p>Git ignores this folder, so it is never committed or uploaded. To back it up, copy the folder or use “Export everything” below.</p>
        <div class="table-wrap"><table><thead><tr><th scope="col">Records</th><th scope="col">Your data</th><th scope="col">Synthetic examples</th></tr></thead><tbody>${counts}</tbody></table></div>`,
      )}
      ${section(
        'Privacy protections',
        html`<ul>
          <li>The lab only listens on this computer (localhost). Other devices on your network cannot reach it, and requests addressed to any other name are refused.</li>
          <li>It makes no internet connections, calls no AI service, and sends no telemetry.</li>
          <li>Imported files are treated as untrusted: every field is checked, nothing in them is ever run, and text is always shown as plain text.</li>
          <li>Only PNG, JPEG and WebP images up to 5 MB are accepted, checked by their contents.</li>
          <li>Forms only work from the lab’s own pages, so another website cannot make changes here.</li>
          <li>Logs record which page was visited, never what you typed or imported.</li>
          <li>Synthetic examples are labelled “Synthetic example”; your own records are labelled “Your data”.</li>
        </ul>`,
      )}
      ${section(
        'Export',
        html`<p>${linkButton('/data/export.json', 'Export everything (JSON)', 'primary')} ${linkButton('/data/results.csv', 'Results summary (CSV)')}</p>
        <p class="muted small">The JSON export keeps every record with its provenance and evaluator identity, and can be imported again without losing them. It may contain your private data: keep it somewhere safe.</p>`,
      )}
      ${section(
        'Import a lab export',
        postForm(
          '/data/import',
          ctx.csrf,
          html`<p class="muted small">Adds records from an export file. Existing records are never overwritten: identical ones are skipped and conflicting ones are reported.</p><input type="file" name="file" accept="application/json,.json" required> ${button('Import', 'secondary')}`,
          { multipart: true },
        ),
      )}
      ${section(
        'Supported formats',
        html`<p>Each format is a JSON Schema document (format version 1). Unknown values are written as <code>null</code>, never as 0. Example files are in the <code>examples/</code> and <code>fixtures/</code> folders of the app.</p>
        <div class="table-wrap"><table><thead><tr><th scope="col">Format</th><th scope="col">What it holds</th></tr></thead><tbody>${formats}</tbody></table></div>`,
      )}
      ${section(
        'Appearance',
        postForm('/theme', ctx.csrf, html`<input type="hidden" name="back" value="/data"><label>Theme <select name="theme"><option value="dark"${theme === 'dark' ? html` selected` : ''}>Dark (default)</option><option value="light"${theme === 'light' ? html` selected` : ''}>Light</option></select></label> ${button('Apply', 'secondary')}`),
      )}
      ${section(
        'Synthetic examples',
        html`<p>The lab ships with made-up examples for every specialist so you can try each workflow. Removing them leaves your own records untouched.</p>
        <div class="toolbar">${postForm('/data/synthetic/remove', ctx.csrf, html`<label class="check"><input type="checkbox" name="confirm" required> I understand the examples will be removed</label> ${button('Remove synthetic examples', 'danger')}`, { cls: 'inline' })}
        ${postForm('/data/synthetic/load', ctx.csrf, button('Load synthetic examples', 'secondary'), { cls: 'inline' })}</div>`,
      )}`;
    render(req, res, ctx, { title: 'Settings / Data', intro: 'Where your data is kept, how it is protected, and how to import, export and back it up.', active: 'data', body });
  });

  router.get('/data/export.json', (_req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="lab-${nowIso().slice(0, DATE_LENGTH)}.evallab-export.json"`);
    res.type('application/json').send(JSON.stringify(buildBundle(ctx.store.snapshot()), null, JSON_INDENT));
  });

  router.get('/data/results.csv', (_req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="lab-results-${nowIso().slice(0, DATE_LENGTH)}.csv"`);
    res.type('text/csv').send(resultsCsv(ctx.store.snapshot().results));
  });

  router.post('/data/import', jsonUpload.single('file'), csrfCheck, async (req, res) => {
    if (!req.file) throw new LifecycleError('Choose an export file to import');
    const outcome = importBundle(JSON.parse(req.file.buffer.toString('utf8')), ctx.store.snapshot());
    if (!outcome.ok) throw new LifecycleError(outcome.message);
    await COLLECTIONS.reduce(async (previous, c) => {
      await previous;
      await ctx.store.addMany(c, outcome.additions[c] as never[]); // additions were validated per collection by importBundle
    }, Promise.resolve());
    await noteEvaluated(ctx.store, outcome.additions.results);
    render(req, res, ctx, {
      title: 'Import a lab export',
      intro: 'What was added from the export file.',
      active: 'data',
      body: html`<p>${outcome.message}</p>${outcome.problems.length ? html`<div class="alert alert-warn"><strong>Not imported:</strong><ul>${outcome.problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}${linkButton('/data', 'Back to Settings / Data', 'primary')}`,
    });
  });

  router.post('/data/synthetic/remove', csrfCheck, async (req, res) => {
    if (!checkbox(bodyOf(req), 'confirm')) throw new LifecycleError('Tick the box to confirm');
    await ctx.store.removeSynthetic();
    redirectDone(res, '/data', 'synthetic-removed');
  });

  router.post('/data/synthetic/load', csrfCheck, async (_req, res) => {
    await loadSyntheticSuite(ctx.store);
    redirectDone(res, '/data', 'synthetic-loaded');
  });

  router.get('/schemas/:file', (req, res) => {
    const file = String(req.params['file'] ?? '');
    const name = file.endsWith(JSON_SUFFIX) ? file.slice(0, -JSON_SUFFIX.length) : file;
    if (!isFormatName(name)) throw new NotFoundError('That format');
    res.type('application/json').send(JSON.stringify(jsonSchemaFor(name), null, JSON_INDENT));
  });

  return router;
}
