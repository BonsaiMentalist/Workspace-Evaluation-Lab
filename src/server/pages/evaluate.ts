/** Evaluate: load saved outputs for frozen cases, score them by hand or with automatic checks, and import outside work. */
import { Router, type Request, type RequestHandler } from 'express';
import type { Multer } from 'multer';
import { z } from 'zod';
import type { EvaluationCase, EvaluationResult, SavedOutput, ToolArtifact } from '../../domain/schemas.js';
import { FORMAT_VERSION, SavedOutput as SavedOutputSchema } from '../../domain/schemas.js';
import { canEvaluate, LifecycleError, markEvaluated } from '../../domain/cases.js';
import { findCase, findOutput, findProfile, findResult, latestCases, outputsForCase, profileForCase, resultsForOutput } from '../../domain/lookup.js';
import { checkResult, manualResult } from '../../domain/results.js';
import { importAssessmentBatch } from '../../domain/imports.js';
import { parseExecutableReport, resultFromExecutableReport } from '../../domain/extensions/executable.js';
import { analyticsJobLineId, joinKeysOf } from '../../domain/extensions/analyticsJoin.js';
import { describeZodError } from '../../domain/errors.js';
import { hashOf, newId, nowIso } from '../../domain/hash.js';
import { assessedBy } from '../../domain/scoring.js';
import { saveImage } from '../../storage/attachments.js';
import type { LabStore } from '../../storage/store.js';
import {
  badge,
  button,
  definitionList,
  empty,
  errorList,
  evaluatorTypeLabel,
  html,
  known,
  linkButton,
  originBadge,
  overallBadge,
  postForm,
  privacyLabel,
  prose,
  reviewBadge,
  section,
  shortDate,
  shortDateTime,
  sourceBadge,
  tip,
  type SafeHtml,
} from '../html.js';
import { bodyOf, commaList, int, longText, num, text, parseJsonFile } from '../form.js';
import { idParam, NotFoundError, redirectDone, render, versionParam, type AppContext } from '../context.js';
import { caseLink, contextView, findingsTable, modelLine, outputBody, outputFacts, scoreSummaryView, splitBadge, TIPS } from '../views.js';
import { findingsFields, findingsFromForm } from './scoringForm.js';
import { HTTP } from '../status.js';
import { passBlindGuard } from '../blindGuard.js';

const KNOWN_MODELS = ['claude-opus', 'claude-sonnet', 'claude-haiku', 'claude-fable', 'sol-6.1', 'gpt-6-astra'];
const MAX_IMPORT_OUTPUTS = 1000;
const FILE_NAME_MAX = 200;
const MIN_TO_COMPARE = 2;

/** Records that a frozen case has results, moving it to "evaluated". */
export async function noteEvaluated(store: LabStore, caseIds: ReadonlyArray<{ readonly caseId: string; readonly caseVersion: number }>): Promise<void> {
  const unique = [...new Map(caseIds.map((k) => [`${k.caseId}@${k.caseVersion}`, k])).values()];
  await unique.reduce(async (previous, key) => {
    await previous;
    const c = findCase(store.snapshot(), key.caseId, key.caseVersion);
    if (c && c.status === 'frozen') await store.replace('cases', markEvaluated(c));
  }, Promise.resolve());
}

function requireFrozenCase(store: LabStore, id: string, version: number): EvaluationCase {
  const c = findCase(store.snapshot(), id, version);
  if (!c) throw new NotFoundError('That case version');
  if (!canEvaluate(c)) throw new LifecycleError('Only frozen, unarchived cases can be evaluated. Validate and freeze the case first');
  return c;
}

function outputForm(csrf: string, c: EvaluationCase, errors: readonly string[]): SafeHtml {
  return postForm(
    `/evaluate/${c.id}/v/${c.version}/outputs`,
    csrf,
    html`${errorList(errors)}
    <datalist id="models">${KNOWN_MODELS.map((m) => html`<option value="${m}"></option>`)}</datalist>
    <div class="row"><label>Short label <input name="label" required placeholder="e.g. Opus · instructions v3"></label>
    <label>Privacy <select name="privacy"><option value="local-private">Private – stays on this computer</option><option value="shareable">Safe to share</option></select></label></div>
    <label>The specialist’s output (paste it here) <textarea name="text" rows="8"></textarea></label>
    <details><summary>Who produced it (model, configuration, Workspace ids)</summary>
      <div class="row"><label>Model <input name="model" list="models"></label><label>Provider <input name="provider" placeholder="claude or codex"></label><label>Effort <input name="effort" placeholder="low, medium, high"></label></div>
      <div class="row"><label>Configuration id <input name="configurationId"></label><label>Fingerprint ${tip(TIPS.fingerprint)} <input name="fingerprint"></label><label>Context configuration <input name="contextConfigId"></label><label>Tools (comma-separated) <input name="tools"></label></div>
      <div class="row"><label>Workspace job id <input name="job"></label><label>Piece <input name="piece" inputmode="numeric"></label><label>Reply id <input name="reply"></label><label>Chat id <input name="chat"></label></div>
    </details>
    <details><summary>Resources used (leave blank when unknown — blank is never treated as zero)</summary>
      <div class="row"><label>New input tokens <input name="uncached" inputmode="numeric"></label><label>Cache write <input name="cacheWrite" inputmode="numeric"></label><label>Cache read <input name="cacheRead" inputmode="numeric"></label><label>Output tokens <input name="output" inputmode="numeric"></label><label>Thinking tokens <input name="thinking" inputmode="numeric"></label><label>Duration (s) <input name="durationS" inputmode="decimal"></label></div>
    </details>
    <details><summary>An image made by a tool (for example an image generator)</summary>
      <p class="muted small">Tool output is kept apart from the specialist’s own interpretation and inspection, so each can be judged on its own.</p>
      <div class="row"><label>Tool name <input name="toolName" placeholder="Image generator"></label><label>Tool model <input name="toolModel"></label></div>
      <label>Image (PNG, JPEG or WebP, up to 5 MB) <input type="file" name="toolImage" accept="image/png,image/jpeg,image/webp"></label>
      <label>Description <input name="toolDescription"></label>
    </details>
    ${button('Save output')}`,
    { multipart: true },
  );
}

async function outputFromForm(req: Request, ctx: AppContext, c: EvaluationCase): Promise<SavedOutput> {
  const body = bodyOf(req);
  const files: unknown = req.files;
  const toolImage = Array.isArray(files) ? (files as Array<{ fieldname: string; buffer: Buffer }>).find((f) => f.fieldname === 'toolImage') : undefined; // multer's file list
  const attachment = toolImage ? await saveImage(ctx.store.attachmentsDir, toolImage.buffer, text(body, 'toolDescription')) : null;
  const toolArtifacts: ToolArtifact[] = attachment
    ? [{ id: 'artifact-1', tool: { name: text(body, 'toolName') || 'Tool', model: text(body, 'toolModel') || null, version: null }, kind: 'image', text: '', attachment, description: text(body, 'toolDescription') }]
    : [];
  const tokenFields = ['uncached', 'cacheWrite', 'cacheRead', 'output', 'thinking'] as const;
  const tokens = Object.fromEntries(tokenFields.map((f) => [f, int(body, f)]));
  const anyTokens = tokenFields.some((f) => int(body, f) !== null);
  const durationS = num(body, 'durationS');
  return SavedOutputSchema.parse({
    schema: 'eval-lab/saved-output',
    schemaVersion: FORMAT_VERSION,
    id: newId('out'),
    caseId: c.id,
    caseVersion: c.version,
    label: text(body, 'label'),
    text: longText(body, 'text'),
    toolArtifacts,
    producedBy: { model: text(body, 'model') || null, provider: text(body, 'provider') || null, effort: text(body, 'effort') || null },
    configuration: { configurationId: text(body, 'configurationId') || null, fingerprint: text(body, 'fingerprint') || null, contextConfigId: text(body, 'contextConfigId') || null, toolConfigIds: commaList(text(body, 'tools')) },
    workspace: { job: text(body, 'job') || null, piece: int(body, 'piece'), phase: text(body, 'job') ? 'worker' : null, reply: text(body, 'reply') || null, chat: text(body, 'chat') || null },
    resources: { tokens: anyTokens ? tokens : null, durationS, provenance: { source: anyTokens || durationS !== null ? 'manual-entry' : 'unknown' } },
    provenance: { origin: 'user', source: 'manual-entry' },
    privacy: text(body, 'privacy') === 'shareable' ? 'shareable' : 'local-private',
    createdAt: nowIso(),
  });
}

function outputCard(o: SavedOutput, results: readonly EvaluationResult[], c: EvaluationCase, csrf: string): SafeHtml {
  return html`<article class="output-card">
    <header><h3><a href="/outputs/${o.id}">${o.label}</a></h3> ${originBadge(o.provenance.origin)}<div class="small muted">${modelLine(o)}</div></header>
    ${results.length ? html`<ul class="plain">${results.map((r) => html`<li><a href="/results/${r.id}">${sourceBadge(assessedBy(r))}</a> ${reviewBadge(r.review.state)} ${overallBadge(r.overall)} <span class="muted small">${shortDate(r.createdAt)}</span></li>`)}</ul>` : html`<p class="muted small">Not assessed yet.</p>`}
    <div class="toolbar">${linkButton(`/outputs/${o.id}/score`, 'Score by hand', 'primary')}
      ${c.checks.length ? postForm(`/outputs/${o.id}/checks`, csrf, html`${button('Run automatic checks', 'secondary')} ${tip(TIPS.deterministic)}`, { cls: 'inline' }) : ''}</div>
  </article>`;
}

const OutputArray = z.array(z.unknown()).max(MAX_IMPORT_OUTPUTS);
const OutputFile = z.object({ outputs: OutputArray });

/** An output file may hold one output, a list, or {"outputs": [...]}. */
function outputsInFile(raw: unknown): unknown[] {
  const asList = OutputArray.safeParse(raw);
  if (asList.success) return asList.data;
  const asObject = OutputFile.safeParse(raw);
  return asObject.success ? asObject.data.outputs : [raw];
}

export function evaluateRoutes(ctx: AppContext, upload: Multer, jsonUpload: Multer, csrfCheck: RequestHandler): Router {
  const router = Router();

  router.get('/evaluate', (req, res) => {
    const lab = ctx.store.snapshot();
    const ready = latestCases(lab).filter(canEvaluate).sort((a, b) => a.specialistId.localeCompare(b.specialistId) || a.title.localeCompare(b.title));
    const importPanel = (action: string, title: string, note: string): SafeHtml =>
      html`<div class="import-panel"><h3>${title}</h3><p class="muted small">${note}</p>${postForm(action, ctx.csrf, html`<input type="file" name="file" accept="application/json,.json" required> ${button('Import', 'secondary')}`, { multipart: true })}</div>`;
    const body = html`
      ${section(
        'Cases ready to evaluate',
        ready.length
          ? html`<div class="table-wrap"><table><thead><tr><th scope="col">Case</th><th scope="col">Specialist</th><th scope="col">Outputs</th><th scope="col">Results</th><th scope="col"></th></tr></thead><tbody>${ready.map((c) => {
              const outputs = outputsForCase(lab, c.id, c.version);
              const results = lab.results.filter((r) => r.caseId === c.id && r.caseVersion === c.version);
              return html`<tr><td>${caseLink(c)} ${splitBadge(c)}</td><td>${c.specialistId}</td><td>${outputs.length}</td><td>${results.length}</td><td>${linkButton(`/evaluate/${c.id}/v/${c.version}`, 'Open', 'primary')}</td></tr>`;
            })}</tbody></table></div>`
          : empty('No frozen cases yet. Validate and freeze a case in the Evaluation Library first.'),
      )}
      ${section(
        'Import work done elsewhere',
        html`<div class="grid-3">
          ${importPanel('/imports/assessments', 'Outside assessments', 'Criterion-level assessments from an AI reviewer or a person, as an imported-assessment batch. AI assessments wait for your spot-check.')}
          ${importPanel('/outputs/import', 'Saved outputs', 'One output, a list, or {"outputs": [...]}, in the saved-output format, for frozen cases.')}
          ${importPanel('/imports/executable', 'Test-runner results', 'An executable-report file written by a local test runner. The lab only reads it; it never runs anything.')}
        </div>`,
      )}`;
    render(req, res, ctx, { title: 'Evaluate', intro: 'Choose a frozen case to load and score its outputs, or import assessments and outputs made elsewhere.', active: 'evaluate', body });
  });

  router.get('/evaluate/:id/v/:version', (req, res) => {
    const c = requireFrozenCase(ctx.store, idParam(req, 'id'), versionParam(req));
    const lab = ctx.store.snapshot();
    const outputs = outputsForCase(lab, c.id, c.version);
    const body = html`
      <div class="toolbar">${caseLink(c)} ${splitBadge(c)} ${linkButton(`/cases/${c.id}/v/${c.version}`, 'Case details')}</div>
      ${section('Task', html`${prose(c.task)}<details><summary>Context given to the specialist</summary>${contextView(c)}</details>`)}
      ${section(
        'Saved outputs',
        outputs.length
          ? html`<div class="grid-2">${outputs.map((o) => outputCard(o, resultsForOutput(lab, o.id), c, ctx.csrf))}</div>`
          : empty('No outputs yet. Add one below or import a file on the Evaluate page.'),
        outputs.length >= MIN_TO_COMPARE
          ? html`${postForm('/compare', ctx.csrf, html`<input type="hidden" name="caseId" value="${c.id}"><input type="hidden" name="caseVersion" value="${c.version}">${outputs.map((o) => html`<input type="hidden" name="outputIds" value="${o.id}">`)}${button('Compare all blind', 'primary')}`, { cls: 'inline' })}
             ${linkButton(`/compare/report?case=${c.id}&version=${c.version}`, 'Criterion-level report')}
             <p class="muted small">To keep a comparison blind, start it before opening the outputs.</p>`
          : html``,
      )}
      ${section('Add an output', outputForm(ctx.csrf, c, []))}`;
    render(req, res, ctx, { title: `Evaluate: ${c.title}`, intro: 'Load the outputs you want to judge for this case, then score each one or compare them blind.', active: 'evaluate', body });
  });

  router.post('/evaluate/:id/v/:version/outputs', upload.any(), csrfCheck, async (req, res) => {
    const c = requireFrozenCase(ctx.store, idParam(req, 'id'), versionParam(req));
    if (!text(bodyOf(req), 'label')) throw new LifecycleError('Give the output a short label');
    await ctx.store.add('outputs', await outputFromForm(req, ctx, c));
    redirectDone(res, `/evaluate/${c.id}/v/${c.version}`, 'output-added');
  });

  router.post('/outputs/import', jsonUpload.single('file'), csrfCheck, async (req, res) => {
    const file = req.file;
    if (!file) throw new LifecycleError('Choose a JSON file to import');
    const list = outputsInFile(parseJsonFile(file.buffer));
    const lab = ctx.store.snapshot();
    const at = nowIso();
    const outcomes = list.map((item, index): SavedOutput | string => {
      const parsed = SavedOutputSchema.safeParse(item, { reportInput: true });
      if (!parsed.success) return `Output ${index + 1}: ${describeZodError(parsed.error)}`;
      const c = findCase(lab, parsed.data.caseId, parsed.data.caseVersion);
      if (!c || !canEvaluate(c)) return `Output ${index + 1} ("${parsed.data.id}"): case "${parsed.data.caseId}" version ${parsed.data.caseVersion} is not a frozen case in this lab.`;
      if (findOutput(lab, parsed.data.id)) return `Output ${index + 1} ("${parsed.data.id}"): an output with this id already exists.`;
      return { ...parsed.data, provenance: { origin: 'user', source: 'file-import', sourceFile: file.originalname.slice(0, FILE_NAME_MAX), importedAt: at, note: '' } };
    });
    const accepted = outcomes.filter((o): o is SavedOutput => typeof o !== 'string');
    await ctx.store.addMany('outputs', accepted);
    const problems = outcomes.filter((o): o is string => typeof o === 'string');
    render(req, res, ctx, {
      title: 'Import outputs',
      intro: 'The result of importing saved outputs from a file.',
      active: 'evaluate',
      body: html`<p>${accepted.length} output(s) imported.</p>${problems.length ? html`<div class="alert alert-warn"><strong>Not imported:</strong><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}${linkButton('/evaluate', 'Back to Evaluate', 'primary')}`,
    });
  });

  const loadOutput = (req: Request): { output: SavedOutput; testCase: EvaluationCase } => {
    const lab = ctx.store.snapshot();
    const output = findOutput(lab, idParam(req, 'id'));
    if (!output) throw new NotFoundError('That output');
    const testCase = findCase(lab, output.caseId, output.caseVersion);
    if (!testCase) throw new NotFoundError('The case for this output');
    return { output, testCase };
  };

  router.get('/outputs/:id', (req, res) => {
    const { output, testCase } = loadOutput(req);
    if (!passBlindGuard(req, res, ctx, output.id, 'evaluate')) return;
    const results = resultsForOutput(ctx.store.snapshot(), output.id);
    const body = html`<div class="toolbar">${caseLink(testCase)} ${originBadge(output.provenance.origin)} ${linkButton(`/outputs/${output.id}/score`, 'Score by hand', 'primary')}</div>
      ${section('Output', outputBody(output))}
      ${section('Who produced it', outputFacts(output))}
      ${section('Assessments', results.length ? html`<ul class="plain">${results.map((r) => html`<li><a href="/results/${r.id}">${sourceBadge(assessedBy(r))}</a> ${reviewBadge(r.review.state)} ${overallBadge(r.overall)} · ${r.evaluator.name} · ${shortDate(r.createdAt)}</li>`)}</ul>` : empty('Not assessed yet.'))}`;
    render(req, res, ctx, { title: output.label, intro: 'One saved output, who produced it, and every assessment of it.', active: 'evaluate', body });
  });

  router.get('/outputs/:id/score', (req, res) => {
    const { output, testCase } = loadOutput(req);
    if (!passBlindGuard(req, res, ctx, output.id, 'evaluate')) return;
    if (!canEvaluate(testCase)) throw new LifecycleError('This case is not frozen, so its outputs cannot be scored');
    const profile = profileForCase(ctx.store.snapshot(), testCase);
    if (!profile) throw new NotFoundError('The profile for this case');
    const body = html`<div class="split-view">
      <div>${section('Output', outputBody(output))}
        ${section('What a good answer does', html`${prose(testCase.expected.behaviour)}<ul>${testCase.expected.acceptanceCriteria.map((a) => html`<li>${a}</li>`)}</ul>${testCase.evidence.length ? html`<h3>Evidence</h3><ul>${testCase.evidence.map((e) => html`<li><strong>${e.id}</strong>: ${e.description}</li>`)}</ul>` : ''}`)}
        ${section('Context', contextView(testCase))}</div>
      <div>${section(
        `Assessment against ${profile.name} rubric v${profile.version}`,
        postForm(
          `/outputs/${output.id}/score`,
          ctx.csrf,
          html`<p class="muted small">Mark each criterion. Use “Inconclusive” when the evidence does not settle it and “Not applicable” when it does not apply. Leave “Not assessed” for criteria you are not judging.</p>
          ${findingsFields(profile, [])}
          <fieldset><legend>Overall</legend>
            <label>Overall note <textarea name="overallNote" rows="2"></textarea></label>
            <label>Uncertainty <textarea name="uncertainty" rows="2"></textarea></label>
            <label>Exclusions (anything left out and why) <textarea name="exclusions" rows="2"></textarea></label>
            <label>Limitations <textarea name="limitations" rows="2"></textarea></label>
            <label>Your name <input name="evaluator" value="${ctx.owner}"></label>
          </fieldset>${button('Save assessment')}`,
        ),
      )}</div></div>`;
    render(req, res, ctx, { title: `Score: ${output.label}`, intro: 'Judge this output criterion by criterion against the case’s evidence.', active: 'evaluate', body });
  });

  router.post('/outputs/:id/score', csrfCheck, async (req, res) => {
    const { output, testCase } = loadOutput(req);
    const profile = profileForCase(ctx.store.snapshot(), testCase);
    if (!profile) throw new NotFoundError('The profile for this case');
    const body = bodyOf(req);
    const result = manualResult(testCase, profile, output, findingsFromForm(body, profile), text(body, 'evaluator') || ctx.owner, {
      overallNote: longText(body, 'overallNote'),
      uncertainty: longText(body, 'uncertainty'),
      exclusions: longText(body, 'exclusions'),
      limitations: longText(body, 'limitations'),
    });
    await ctx.store.add('results', result);
    await noteEvaluated(ctx.store, [result]);
    redirectDone(res, `/results/${result.id}`, 'result-saved');
  });

  router.post('/outputs/:id/checks', csrfCheck, async (req, res) => {
    const { output, testCase } = loadOutput(req);
    const profile = profileForCase(ctx.store.snapshot(), testCase);
    if (!profile) throw new NotFoundError('The profile for this case');
    const result = checkResult(testCase, profile, output);
    const previous = findResult(ctx.store.snapshot(), result.id);
    if (previous) {
      // Same fingerprint means same case version, checks, engine and text; identical findings show the checks are reproducible.
      if (hashOf(previous.findings) !== hashOf(result.findings)) throw new LifecycleError('These checks gave different findings from last time, which should not happen. Please report it');
      redirectDone(res, `/results/${previous.id}`, 'checks-same');
      return;
    }
    await ctx.store.add('results', result);
    await noteEvaluated(ctx.store, [result]);
    redirectDone(res, `/results/${result.id}`, 'checks-run');
  });

  router.post('/imports/assessments', jsonUpload.single('file'), csrfCheck, async (req, res) => {
    const file = req.file;
    if (!file) throw new LifecycleError('Choose a JSON file to import');
    const outcome = importAssessmentBatch(parseJsonFile(file.buffer), {
      lab: ctx.store.snapshot(),
      sourceFile: file.originalname.slice(0, FILE_NAME_MAX),
      now: nowIso(),
      origin: 'user',
    });
    const rejectedList = outcome.rejected.length ? html`<div class="alert alert-warn"><strong>Rejected entries (not stored):</strong><ul>${outcome.rejected.map((r) => html`<li>${r.message}</li>`)}</ul></div>` : '';
    if (!outcome.ok) {
      render(req, res, ctx, { title: 'Import outside assessments', intro: 'Nothing was imported from this file.', active: 'evaluate', body: html`<div class="alert alert-bad" role="alert">${outcome.message}</div>${rejectedList}${linkButton('/evaluate', 'Back to Evaluate')}` }, HTTP.badRequest);
      return;
    }
    await ctx.store.addMany('results', outcome.results);
    await ctx.store.addMany('comparisons', outcome.comparisons);
    await ctx.store.add('importBatches', outcome.batch);
    await noteEvaluated(ctx.store, [...outcome.results, ...outcome.comparisons]);
    const isAi = outcome.batch.evaluator.type === 'ai-reviewer';
    render(req, res, ctx, {
      title: 'Import outside assessments',
      intro: 'What was imported from this file, and what happens next.',
      active: 'evaluate',
      body: html`<p>${outcome.results.length} assessment(s) and ${outcome.comparisons.length} comparison(s) imported from <strong>${outcome.batch.sourceFile ?? 'the file'}</strong>, made by ${evaluatorTypeLabel(outcome.batch.evaluator.type)} “${outcome.batch.evaluator.name}”${outcome.batch.evaluator.version ? ` (${outcome.batch.evaluator.version})` : ''}.</p>
        ${isAi ? html`<p>AI assessments count in no report until you spot-check them. Check at least ${outcome.batch.spotCheckSample} one by one; then you may accept the rest together. ${tip(TIPS.spotCheck)}</p>` : ''}
        ${rejectedList}${linkButton('/review', 'Go to spot-check', 'primary')}`,
    });
  });

  router.post('/imports/executable', jsonUpload.single('file'), csrfCheck, async (req, res) => {
    const file = req.file;
    if (!file) throw new LifecycleError('Choose a JSON file to import');
    const report = parseExecutableReport(parseJsonFile(file.buffer));
    const lab = ctx.store.snapshot();
    const testCase = findCase(lab, report.caseId, report.caseVersion);
    const output = findOutput(lab, report.outputId);
    if (!testCase || !output) throw new LifecycleError('The report names a case version or output that is not in this lab');
    const profile = profileForCase(lab, testCase);
    if (!profile) throw new NotFoundError('The profile for this case');
    const result = resultFromExecutableReport(report, testCase, profile, output, file.originalname.slice(0, FILE_NAME_MAX), nowIso());
    if (findResult(lab, result.id)) throw new LifecycleError('This test-runner report was already imported');
    await ctx.store.add('results', result);
    await noteEvaluated(ctx.store, [result]);
    redirectDone(res, `/results/${result.id}`, 'runner-imported');
  });

  router.get('/results/:id', (req, res) => {
    const lab = ctx.store.snapshot();
    const r = findResult(lab, idParam(req, 'id'));
    if (!r) throw new NotFoundError('That result');
    if (!passBlindGuard(req, res, ctx, r.outputId, 'evaluate')) return;
    const profile = findProfile(lab, r.profileId, r.profileVersion);
    const testCase = findCase(lab, r.caseId, r.caseVersion);
    const output = findOutput(lab, r.outputId);
    const lineId = analyticsJobLineId(joinKeysOf(r));
    const body = html`<div class="toolbar">${sourceBadge(assessedBy(r))} ${reviewBadge(r.review.state)} ${originBadge(r.provenance.origin)}
        ${r.review.state === 'needs-spot-check' ? linkButton(`/review/${r.id}`, 'Spot-check this', 'primary') : ''}</div>
      ${profile ? section('Outcome', scoreSummaryView(profile, r.findings)) : ''}
      ${profile ? section(`Findings (rubric: ${profile.name} v${profile.version})`, findingsTable(profile, r.findings, r.review.originalFindings)) : ''}
      ${section(
        'Notes',
        definitionList([
          ['Overall note', r.overallNote || null],
          ['Uncertainty', r.uncertainty || null],
          ['Exclusions', r.exclusions || null],
          ['Limitations', r.limitations || null],
        ]),
      )}
      ${section(
        'How this result was made',
        definitionList([
          ['Case', testCase ? html`${caseLink(testCase)} (version ${r.caseVersion})` : `${r.caseId} v${r.caseVersion}`],
          ['Output', output ? html`<a href="/outputs/${output.id}">${output.label}</a>` : r.outputId],
          ['Set', r.split === 'held-out' ? html`Held-out ${tip(TIPS.heldOut)}` : 'Development'],
          ['Method', r.methods.join(', ')],
          ['Evaluator', html`${evaluatorTypeLabel(r.evaluator.type)}: ${r.evaluator.name}${r.evaluator.version ? ` (${r.evaluator.version})` : ''}`],
          ['Evaluated on', shortDateTime(r.evaluator.date)],
          ['Spot-check', r.review.state === 'not-required' ? 'Not required' : html`${reviewBadge(r.review.state)} ${r.review.decidedBy ? `by ${r.review.decidedBy}` : ''} ${r.review.decidedAt ? shortDateTime(r.review.decidedAt) : ''}${r.review.via === 'batch' ? ' (accepted with the rest of its batch)' : ''}${r.review.note ? ` — ${r.review.note}` : ''}`],
          ['Imported from', r.provenance.sourceFile ? html`${r.provenance.sourceFile}${r.importRef ? html` · batch ${r.importRef.batchId}, entry ${r.importRef.entryId}` : ''}` : null],
          ['Run id', r.runId],
          ['Compared against', r.baseline ? `${r.baseline.runId}${r.baseline.label ? ` (${r.baseline.label})` : ''}` : null],
          ['Known failure', r.knownFailure ? html`${badge('warn', 'Known, tracked failure')} ${r.knownFailure.reference} ${tip(TIPS.knownFailure)}` : null],
          ['Recorded', shortDateTime(r.createdAt)],
        ]),
      )}
      ${section(
        'Who produced the output',
        definitionList([
          ['Model', known(r.model.model)],
          ['Provider', known(r.model.provider)],
          ['Effort', known(r.model.effort)],
          ['Configuration', known(r.configuration.configurationId)],
          ['Workspace job', known(r.workspace.job)],
          ['Workspace reply', known(r.workspace.reply)],
          ['Analytics line', lineId ? html`<code>${lineId}</code> in jobs.jsonl` : known(null)],
          ['Privacy', output ? privacyLabel(output.privacy) : null],
        ]),
      )}`;
    render(req, res, ctx, { title: `Result: ${testCase?.title ?? r.caseId}`, intro: 'One assessment: its outcome, criterion findings, and exactly how and by whom it was made.', active: 'evaluate', body });
  });

  return router;
}
