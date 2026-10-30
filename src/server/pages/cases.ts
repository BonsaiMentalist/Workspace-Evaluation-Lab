/** Evaluation Library: search, create, inspect, edit (as new versions), validate, freeze, archive and import cases. */
import { Router, type Request, type RequestHandler } from 'express';
import type { Multer } from 'multer';
import { z } from 'zod';
import type { ContextItem, DeterministicCheck, EvaluationCase, Method } from '../../domain/schemas.js';
import { DeterministicCheck as CheckSchema, EvaluationCase as CaseSchema, FORMAT_VERSION, Method as MethodSchema } from '../../domain/schemas.js';
import {
  caseContentHash,
  editCase,
  freezeCase,
  freezeIntact,
  LifecycleError,
  STATUS_LABELS,
  testInputFor,
  validateCase,
  validationProblems,
  type CaseChanges,
} from '../../domain/cases.js';
import { describeCheck } from '../../domain/checks.js';
import { caseVersions, findCase, findObservation, latestCase, latestCases, latestProfile, latestProfiles, outputsForCase, profileForCase, type LabSnapshot } from '../../domain/lookup.js';
import { describeZodError } from '../../domain/errors.js';
import { newId, nowIso } from '../../domain/hash.js';
import { saveImage } from '../../storage/attachments.js';
import { badge, button, definitionList, empty, errorList, html, linkButton, originBadge, postForm, privacyLabel, prose, section, shortDate, tip, type SafeHtml } from '../html.js';
import { bodyOf, checkbox, commaList, int, lines, longText, many, rows, text, type FormBody, parseJsonFile } from '../form.js';
import { idParam, NotFoundError, queryText, redirectDone, render, versionParam, type AppContext } from '../context.js';
import { caseLink, caseStatusBadge, contextView, splitBadge, TIPS } from '../views.js';
import { HTTP } from '../status.js';

const METHOD_LABELS = {
  deterministic: 'Automatic checks',
  manual: 'Evidence-based manual assessment',
  'blinded-comparison': 'Blinded comparison',
  executable: 'Test-runner results',
} as const satisfies Record<Method, string>;

const CHECK_TYPE_LABELS = {
  'required-phrase': 'Required wording (phrases, one per line)',
  'forbidden-phrase': 'Forbidden claim (phrases, one per line)',
  'expected-label': 'Expected classification (label + accepted values)',
  'required-field': 'Required structured field (JSON field path in "Label / field")',
  'evidence-reference': 'Evidence cited (evidence ids, one per line; number = minimum)',
  'max-words': 'Length limit (number = maximum words)',
} as const satisfies Record<DeterministicCheck['type'], string>;

const BLANK_CONTEXT_ROWS = 2;
const BLANK_EVIDENCE_ROWS = 2;
const BLANK_CHECK_ROWS = 1;
const SLUG_LENGTH = 40;
const MAX_IMPORT_CASES = 500;
const ID_SUFFIX_LENGTH = 4;
const FILE_NAME_MAX = 200;
const JSON_INDENT = 2;
// Characters other than lowercase letters and digits, collapsed to one dash: "Stale status!" → "stale-status-"; "abc" is unchanged.
// https://regex101.com/?flavor=javascript&regex=%5B%5Ea-z0-9%5D%2B&flags=g&testString=stale%20status!%0Aabc
const NON_SLUG = /[^a-z0-9]+/g;
// Leading or trailing dashes: "-abc-" → "abc"; "abc" is unchanged.
// https://regex101.com/?flavor=javascript&regex=%5E-%2B%7C-%2B%24&flags=g&testString=-abc-%0Aabc
const EDGE_DASHES = /^-+|-+$/g;

const slug = (s: string): string => s.toLowerCase().replace(NON_SLUG, '-').replace(EDGE_DASHES, '').slice(0, SLUG_LENGTH) || 'case';

// ---------------------------------------------------------------------------
// Form → case
// ---------------------------------------------------------------------------

interface ParsedForm {
  readonly changes: CaseChanges;
  readonly errors: string[];
}

type UploadedFiles = Readonly<Record<string, ReadonlyArray<{ readonly buffer: Buffer }>>>;

function filesOf(req: Request): UploadedFiles {
  const files: unknown = req.files;
  if (!Array.isArray(files)) return {};
  return files.reduce<Record<string, Array<{ buffer: Buffer }>>>((acc, f: { fieldname: string; buffer: Buffer }) => ({ ...acc, [f.fieldname]: [...(acc[f.fieldname] ?? []), f] }), {});
}

function checkFromRow(row: FormBody, index: number): DeterministicCheck | string | null {
  const type = text(row, 'type');
  if (!type || checkbox(row, 'remove')) return null;
  const values = lines(longText(row, 'values'));
  const number = int(row, 'number');
  const candidate = {
    id: text(row, 'id') || `check-${index + 1}`,
    criterionId: text(row, 'criterionId'),
    description: text(row, 'description'),
    type,
    phrases: values,
    match: text(row, 'match') || 'any',
    label: text(row, 'label'),
    accepted: values,
    field: text(row, 'label'),
    refs: values,
    min: number ?? 1,
    max: number ?? undefined,
  };
  const parsed = CheckSchema.safeParse(candidate);
  return parsed.success ? parsed.data : `Automatic check ${index + 1}: ${describeZodError(parsed.error)}`;
}

async function caseFromForm(req: Request, ctx: AppContext, existing: EvaluationCase | null): Promise<ParsedForm> {
  const body = bodyOf(req);
  const files = filesOf(req);
  const errors: string[] = [];
  const contextRows = rows(body, 'context');
  const context = await Promise.all(
    contextRows.map(async (row, index): Promise<ContextItem | null> => {
      const title = text(row, 'title');
      const file = files[`contextImage${index}`]?.[0];
      const previous = existing?.context.find((c) => c.id === text(row, 'id'));
      if (checkbox(row, 'remove') || (!title && !longText(row, 'text') && !file)) return null;
      const attachment = file ? await saveImage(ctx.store.attachmentsDir, file.buffer, title) : (previous?.attachment ?? null);
      return {
        id: text(row, 'id') || `ctx-${index + 1}`,
        title: title || `Context ${index + 1}`,
        kind: attachment ? 'image' : 'text',
        text: longText(row, 'text'),
        attachment,
        authoritative: checkbox(row, 'authoritative'),
        note: text(row, 'note'),
      };
    }),
  );
  const checks = rows(body, 'checks').map(checkFromRow);
  errors.push(...checks.filter((c): c is string => typeof c === 'string'));
  const evidence = rows(body, 'evidence')
    .filter((row) => text(row, 'id') && !checkbox(row, 'remove'))
    .map((row) => ({ id: text(row, 'id'), description: longText(row, 'description'), contextItemId: text(row, 'contextItemId') || null }));
  const methods = many(body, 'methods').filter((m): m is Method => MethodSchema.safeParse(m).success);
  const specialistId = text(body, 'specialistId');
  const lab = ctx.store.snapshot();
  const latest = latestProfile(lab, specialistId);
  const keepRubric = existing && existing.specialistId === specialistId && existing.profileVersion !== null && !checkbox(body, 'updateRubric');
  const changes: CaseChanges = {
    title: text(body, 'title'),
    specialistId,
    profileVersion: keepRubric ? existing.profileVersion : (latest?.version ?? null),
    capability: text(body, 'capability') || 'primary',
    split: text(body, 'split') === 'held-out' ? 'held-out' : 'development',
    task: longText(body, 'task'),
    context: context.filter((c): c is ContextItem => c !== null),
    contextNote: longText(body, 'contextNote'),
    expected: {
      behaviour: longText(body, 'behaviour'),
      acceptanceCriteria: lines(longText(body, 'acceptanceCriteria')),
      referenceAnswer: longText(body, 'referenceAnswer'),
      answerKind: (['objective', 'judgement', 'mixed'] as const).find((k) => k === text(body, 'answerKind')) ?? 'judgement',
    },
    evidence,
    methods,
    checks: checks.filter((c): c is DeterministicCheck => c !== null && typeof c !== 'string'),
    limitations: longText(body, 'limitations'),
    ambiguity: (['clear', 'some', 'ambiguous'] as const).find((k) => k === text(body, 'ambiguity')) ?? 'clear',
    ambiguityNote: longText(body, 'ambiguityNote'),
    privacy: (['local-private', 'shareable', 'synthetic'] as const).find((k) => k === text(body, 'privacy')) ?? 'local-private',
    tags: commaList(text(body, 'tags')),
  };
  if (!changes.title) errors.push('Give the case a title.');
  if (!latest) errors.push('Choose a specialist.');
  return { changes, errors };
}

// ---------------------------------------------------------------------------
// Form view
// ---------------------------------------------------------------------------

function caseForm(lab: LabSnapshot, csrf: string, action: string, c: Partial<EvaluationCase>, errors: readonly string[], submitLabel: string): SafeHtml {
  const profiles = latestProfiles(lab);
  const capabilities = [...new Set(profiles.flatMap((p) => p.capabilities.map((cap) => cap.id)))];
  const latestRubric = c.specialistId ? latestProfile(lab, c.specialistId)?.version : undefined;
  const criteria = profiles.flatMap((p) => p.criteria.map((cr) => ({ value: cr.id, label: `${p.name}: ${cr.name}` })));
  const contextRows = [...(c.context ?? []), ...Array.from({ length: BLANK_CONTEXT_ROWS }, () => null)];
  const evidenceRows = [...(c.evidence ?? []), ...Array.from({ length: BLANK_EVIDENCE_ROWS }, () => null)];
  const checkRows = [...(c.checks ?? []), ...Array.from({ length: BLANK_CHECK_ROWS }, () => null)];
  const option = (value: string, label: string, selected: boolean): SafeHtml => html`<option value="${value}"${selected ? html` selected` : ''}>${label}</option>`;
  const checkValues = (check: DeterministicCheck | null): string => {
    if (!check) return '';
    const byType: Record<DeterministicCheck['type'], () => readonly string[]> = {
      'required-phrase': () => (check.type === 'required-phrase' ? check.phrases : []),
      'forbidden-phrase': () => (check.type === 'forbidden-phrase' ? check.phrases : []),
      'expected-label': () => (check.type === 'expected-label' ? check.accepted : []),
      'required-field': () => [],
      'evidence-reference': () => (check.type === 'evidence-reference' ? check.refs : []),
      'max-words': () => [],
    };
    return byType[check.type]().join('\n');
  };
  const checkLabel = (check: DeterministicCheck | null): string => {
    if (check?.type === 'expected-label') return check.label;
    return check?.type === 'required-field' ? check.field : '';
  };
  const checkNumber = (check: DeterministicCheck | null): string => {
    if (check?.type === 'evidence-reference') return String(check.min);
    return check?.type === 'max-words' ? String(check.max) : '';
  };

  return postForm(
    action,
    csrf,
    html`${errorList(errors)}
    <fieldset><legend>What is being evaluated</legend>
      <label>Title <input name="title" required maxlength="300" value="${c.title ?? ''}"></label>
      <div class="row">
        <label>Specialist <select name="specialistId">${profiles.map((p) => option(p.id, p.name, p.id === c.specialistId))}</select></label>
        <label>Capability ${tip(TIPS.capability)} <select name="capability">${capabilities.map((cap) => option(cap, cap, cap === (c.capability ?? 'primary')))}</select></label>
        <label>Set ${tip(TIPS.heldOut)} <select name="split">${option('development', 'Development', c.split !== 'held-out')}${option('held-out', 'Held-out', c.split === 'held-out')}</select></label>
      </div>
      ${c.profileVersion && latestRubric && latestRubric > c.profileVersion ? html`<label class="check"><input type="checkbox" name="updateRubric"> Use the latest rubric (version ${latestRubric} instead of ${c.profileVersion})</label>` : ''}
      <label>Task given to the specialist <textarea name="task" rows="5">${c.task ?? ''}</textarea></label>
    </fieldset>
    <fieldset><legend>Context and reference materials</legend>
      <p class="muted small">Everything the specialist can see. Mark rules, canon or newer records that settle what is correct as authoritative.</p>
      ${contextRows.map(
        (item, i) => html`<div class="subform">
          <input type="hidden" name="context[${i}][id]" value="${item?.id ?? ''}">
          <div class="row"><label>Title <input name="context[${i}][title]" value="${item?.title ?? ''}"></label>
          <label class="check"><input type="checkbox" name="context[${i}][authoritative]"${item?.authoritative ? html` checked` : ''}> Authoritative</label>
          ${item ? html`<label class="check"><input type="checkbox" name="context[${i}][remove]"> Remove</label>` : ''}</div>
          <label>Text <textarea name="context[${i}][text]" rows="3">${item?.text ?? ''}</textarea></label>
          <label>Image (PNG, JPEG or WebP, up to 5 MB) ${item?.attachment ? html`<span class="muted small">current: ${item.attachment.name}</span>` : ''}<input type="file" name="contextImage${i}" accept="image/png,image/jpeg,image/webp"></label>
        </div>`,
      )}
      <label>Context in words (if there are no items above) <textarea name="contextNote" rows="2">${c.contextNote ?? ''}</textarea></label>
    </fieldset>
    <fieldset><legend>Expected behaviour</legend>
      <label>Expected behaviour <textarea name="behaviour" rows="3">${c.expected?.behaviour ?? ''}</textarea></label>
      <label>Acceptance criteria (one per line) <textarea name="acceptanceCriteria" rows="3">${(c.expected?.acceptanceCriteria ?? []).join('\n')}</textarea></label>
      <label>Kind of expected answer <select name="answerKind">${option('judgement', 'A matter of judgement', c.expected?.answerKind === 'judgement')}${option('objective', 'Objective (needs authoritative evidence)', c.expected?.answerKind === 'objective')}${option('mixed', 'Partly objective', c.expected?.answerKind === 'mixed')}</select></label>
      <label>Reference answer (optional; never shown to a model being tested) <textarea name="referenceAnswer" rows="3">${c.expected?.referenceAnswer ?? ''}</textarea></label>
      <h3>Authoritative evidence</h3>
      ${evidenceRows.map(
        (e, i) => html`<div class="row subform"><label>Id <input name="evidence[${i}][id]" value="${e?.id ?? ''}" placeholder="E1" maxlength="40"></label>
          <label class="grow">What it shows <input name="evidence[${i}][description]" value="${e?.description ?? ''}"></label>
          <label>Context item id <input name="evidence[${i}][contextItemId]" value="${e?.contextItemId ?? ''}"></label>
          ${e ? html`<label class="check"><input type="checkbox" name="evidence[${i}][remove]"> Remove</label>` : ''}</div>`,
      )}
    </fieldset>
    <fieldset><legend>How it is evaluated</legend>
      <div class="row">${(Object.keys(METHOD_LABELS) as Method[]).map(
        (m) => html`<label class="check"><input type="checkbox" name="methods" value="${m}"${(c.methods ?? []).includes(m) ? html` checked` : ''}> ${METHOD_LABELS[m]}</label>`,
      )}</div>
      <h3>Automatic checks ${tip(TIPS.deterministic)}</h3>
      ${checkRows.map(
        (check, i) => html`<div class="subform">
          <input type="hidden" name="checks[${i}][id]" value="${check?.id ?? ''}">
          <div class="row"><label>Kind <select name="checks[${i}][type]">${option('', '— none —', !check)}${(Object.keys(CHECK_TYPE_LABELS) as Array<DeterministicCheck['type']>).map((t) => option(t, CHECK_TYPE_LABELS[t], check?.type === t))}</select></label>
          <label>Criterion it decides <select name="checks[${i}][criterionId]">${criteria.map((cr) => option(cr.value, cr.label, check?.criterionId === cr.value))}</select></label>
          ${check ? html`<label class="check"><input type="checkbox" name="checks[${i}][remove]"> Remove</label>` : ''}</div>
          <div class="row"><label>Label / field <input name="checks[${i}][label]" value="${checkLabel(check)}"></label>
          <label>Number <input name="checks[${i}][number]" inputmode="numeric" value="${checkNumber(check)}"></label>
          <label>Match <select name="checks[${i}][match]">${option('any', 'Any phrase', check?.type !== 'required-phrase' || check.match === 'any')}${option('all', 'All phrases', check?.type === 'required-phrase' && check.match === 'all')}</select></label></div>
          <label>Values (one per line) <textarea name="checks[${i}][values]" rows="2">${checkValues(check)}</textarea></label>
          <label>Description <input name="checks[${i}][description]" value="${check?.description ?? ''}"></label>
        </div>`,
      )}
    </fieldset>
    <fieldset><legend>Limits, ambiguity and privacy</legend>
      <label>Known limitations and ambiguities (write "None known" if none) <textarea name="limitations" rows="2">${c.limitations ?? ''}</textarea></label>
      <div class="row"><label>Ambiguity <select name="ambiguity">${option('clear', 'Clear', c.ambiguity === 'clear')}${option('some', 'Some ambiguity', c.ambiguity === 'some')}${option('ambiguous', 'Deliberately ambiguous', c.ambiguity === 'ambiguous')}</select></label>
      <label>Privacy <select name="privacy">${option('local-private', 'Private – stays on this computer', c.privacy !== 'shareable' && c.privacy !== 'synthetic')}${option('shareable', 'Safe to share', c.privacy === 'shareable')}${option('synthetic', 'Made-up example', c.privacy === 'synthetic')}</select></label>
      <label>Tags (comma-separated) <input name="tags" value="${(c.tags ?? []).join(', ')}"></label></div>
      <label>What makes it ambiguous <textarea name="ambiguityNote" rows="2">${c.ambiguityNote ?? ''}</textarea></label>
      <label>Note about this change <input name="changeNote" value=""></label>
    </fieldset>
    ${button(submitLabel)}`,
    { multipart: true, cls: 'case-form' },
  );
}

// ---------------------------------------------------------------------------
// Case detail
// ---------------------------------------------------------------------------

function lifecyclePanel(c: EvaluationCase, lab: LabSnapshot, csrf: string): SafeHtml {
  const base = `/cases/${c.id}/v/${c.version}`;
  const isLatest = latestCase(lab, c.id)?.version === c.version;
  if (c.status === 'candidate') {
    const problems = validationProblems(c, profileForCase(lab, c));
    return html`<p>This case is a draft. Validating it confirms it states everything needed to judge it.</p>
      ${problems.length ? html`<div class="alert alert-warn"><strong>Still needed before validation:</strong><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : html`<p class="good-text">Everything needed is present.</p>`}
      ${postForm(`${base}/validate`, csrf, html`<label>Validation notes (optional) <input name="notes"></label>${button('Validate this case')}`)}`;
  }
  if (c.status === 'validated')
    return html`<p>Validated by ${c.validation?.validatedBy ?? 'unknown'} on ${shortDate(c.validation?.validatedAt ?? null)}. Freezing fixes its test conditions so results stay comparable. ${tip(TIPS.frozen)}</p>
      ${postForm(`${base}/freeze`, csrf, button('Freeze this case'))}`;
  const intact = freezeIntact(c);
  return html`<p>Frozen on ${shortDate(c.freeze?.frozenAt ?? null)} by ${c.freeze?.frozenBy ?? 'unknown'}. ${tip(TIPS.frozen)}</p>
    <p class="small">Content fingerprint: <code>${c.freeze?.contentHash ?? ''}</code> ${intact ? badge('good', 'Matches') : badge('bad', 'Does not match – content changed')}</p>
    ${c.freeze?.freezeSetId ? html`<p class="small">Freeze set: ${c.freeze.freezeSetId} <code>${c.freeze.freezeSetHash ?? ''}</code></p>` : ''}
    ${isLatest && !c.archived ? linkButton(`/evaluate/${c.id}/v/${c.version}`, 'Evaluate outputs for this case', 'primary') : ''}`;
}

function caseDetail(c: EvaluationCase, lab: LabSnapshot, csrf: string): SafeHtml {
  const base = `/cases/${c.id}/v/${c.version}`;
  const profile = profileForCase(lab, c);
  const versions = caseVersions(lab, c.id);
  const outputs = outputsForCase(lab, c.id, c.version);
  const results = lab.results.filter((r) => r.caseId === c.id && r.caseVersion === c.version);
  const checks = c.checks.map((check) => {
    const d = describeCheck(check);
    return html`<li><strong>${d.plainName}</strong> → ${check.criterionId}${check.description ? html`: ${check.description}` : ''}<div class="muted small">Shows: ${d.establishes} Cannot show: ${d.cannotEstablish}</div></li>`;
  });
  const answers = html`${prose(c.expected.behaviour)}
    <h3>Acceptance criteria</h3>${c.expected.acceptanceCriteria.length ? html`<ul>${c.expected.acceptanceCriteria.map((a) => html`<li>${a}</li>`)}</ul>` : empty('None yet.')}
    ${c.expected.referenceAnswer ? html`<h3>Reference answer</h3>${prose(c.expected.referenceAnswer)}` : ''}`;
  return html`
    <div class="toolbar">${caseStatusBadge(c)} ${splitBadge(c)} ${originBadge(c.provenance.origin)}
      ${linkButton(`${base}/edit`, c.status === 'frozen' || c.status === 'evaluated' ? 'Edit (creates a new version)' : 'Edit')}
      ${linkButton(`${base}/test-input.json`, 'Download test input')}
      ${postForm(`/cases/${c.id}/archive`, csrf, button(c.archived ? 'Restore from archive' : 'Archive', 'secondary'), { cls: 'inline' })}
    </div>
    ${section('Lifecycle', lifecyclePanel(c, lab, csrf))}
    ${section(
      'About this case',
      definitionList([
        ['Case id', `${c.id} · version ${c.version}`],
        ['Specialist', profile ? html`<a href="/profiles/${profile.id}/v/${profile.version}">${profile.name}</a>` : c.specialistId],
        ['Rubric version', html`${c.profileVersion ?? 'latest'} ${tip(TIPS.rubric)}`],
        ['Capability', c.capability],
        ['Methods', c.methods.map((m) => METHOD_LABELS[m]).join(', ') || 'none yet'],
        ['Privacy', privacyLabel(c.privacy)],
        ['Provenance', html`${c.provenance.source}${c.provenance.sourceFile ? html` · ${c.provenance.sourceFile}` : ''} ${tip(TIPS.provenance)}`],
        ['Created', shortDate(c.createdAt)],
        ['Tags', c.tags.join(', ') || 'none'],
      ]),
    )}
    ${section('Task', prose(c.task))}
    ${section('Context and reference materials', contextView(c))}
    ${section(
      'Expected behaviour',
      c.split === 'held-out'
        ? html`<details><summary>Show expected behaviour (held-out case) ${tip(TIPS.heldOut)}</summary>${answers}</details>`
        : answers,
    )}
    ${section('Authoritative evidence', c.evidence.length ? html`<ul>${c.evidence.map((e) => html`<li><strong>${e.id}</strong>: ${e.description}${e.contextItemId ? html` <span class="muted small">(${e.contextItemId})</span>` : ''}</li>`)}</ul>` : empty('None listed.'))}
    ${section('Automatic checks', checks.length ? html`<ul>${checks}</ul>` : empty('No automatic checks.'))}
    ${section('Limitations and ambiguity', html`${prose(c.limitations)}<p>Ambiguity: <strong>${c.ambiguity}</strong></p>${c.ambiguityNote ? prose(c.ambiguityNote) : ''}`)}
    ${section('Outputs and results', html`<p>${outputs.length} saved output(s) and ${results.length} result(s) for this version.</p>`)}
    ${section(
      'Versions',
      html`<ul class="plain">${versions.map(
        (v) => html`<li><a href="/cases/${v.id}/v/${v.version}">Version ${v.version}</a> · ${STATUS_LABELS[v.status]} · ${shortDate(v.createdAt)}${v.changeNote ? html` · ${v.changeNote}` : ''}${v.version === c.version ? html` ${badge('info', 'Viewing')}` : ''}</li>`,
      )}</ul>`,
    )}`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const CaseList = z.array(z.unknown()).max(MAX_IMPORT_CASES);
const CaseListFile = z.object({ cases: CaseList });

/** A case file may hold one case, a list of cases, or {"cases": [...]}. */
function casesInFile(raw: unknown): unknown[] {
  const asList = CaseList.safeParse(raw);
  if (asList.success) return asList.data;
  const asObject = CaseListFile.safeParse(raw);
  return asObject.success ? asObject.data.cases : [raw];
}

export function caseRoutes(ctx: AppContext, upload: Multer, jsonUpload: Multer, csrfCheck: RequestHandler): Router {
  const router = Router();

  router.get('/cases', (req, res) => {
    const lab = ctx.store.snapshot();
    const q = queryText(req, 'q').toLowerCase();
    const filters = { specialist: queryText(req, 'specialist'), status: queryText(req, 'status'), split: queryText(req, 'split'), origin: queryText(req, 'origin') };
    const showArchived = queryText(req, 'archived') === 'show';
    const cases = latestCases(lab)
      .filter((c) => showArchived || !c.archived)
      .filter((c) => !q || [c.title, c.task, c.id, ...c.tags].some((t) => t.toLowerCase().includes(q)))
      .filter((c) => !filters.specialist || c.specialistId === filters.specialist)
      .filter((c) => !filters.status || c.status === filters.status)
      .filter((c) => !filters.split || c.split === filters.split)
      .filter((c) => !filters.origin || c.provenance.origin === filters.origin)
      .sort((a, b) => a.specialistId.localeCompare(b.specialistId) || a.title.localeCompare(b.title));
    const option = (value: string, label: string, current: string): SafeHtml => html`<option value="${value}"${value === current ? html` selected` : ''}>${label}</option>`;
    const body = html`
      <form method="get" action="/cases" class="filters">
        <label>Search <input name="q" value="${queryText(req, 'q')}" placeholder="title, task, id or tag"></label>
        <label>Specialist <select name="specialist">${option('', 'All', filters.specialist)}${latestProfiles(lab).map((p) => option(p.id, p.name, filters.specialist))}</select></label>
        <label>Status <select name="status">${option('', 'All', filters.status)}${(Object.keys(STATUS_LABELS) as Array<keyof typeof STATUS_LABELS>).map((s) => option(s, STATUS_LABELS[s], filters.status))}</select></label>
        <label>Set <select name="split">${option('', 'All', filters.split)}${option('development', 'Development', filters.split)}${option('held-out', 'Held-out', filters.split)}</select></label>
        <label>Origin <select name="origin">${option('', 'All', filters.origin)}${option('synthetic', 'Synthetic examples', filters.origin)}${option('user', 'Your data', filters.origin)}</select></label>
        <label class="check"><input type="checkbox" name="archived" value="show"${showArchived ? html` checked` : ''}> Show archived</label>
        <button class="btn btn-secondary" type="submit">Filter</button>
      </form>
      <div class="toolbar">${linkButton('/cases/new', 'New case', 'primary')}</div>
      ${
        cases.length
          ? html`<div class="table-wrap"><table><thead><tr><th scope="col">Case</th><th scope="col">Specialist</th><th scope="col">Status</th><th scope="col">Version</th><th scope="col">Origin</th></tr></thead>
        <tbody>${cases.map((c) => html`<tr><td>${caseLink(c)} ${splitBadge(c)}${c.ambiguity === 'ambiguous' ? html` ${badge('info', 'Ambiguous')}` : ''}</td><td>${c.specialistId}</td><td>${caseStatusBadge(c)}</td><td>${c.version}</td><td>${originBadge(c.provenance.origin)}</td></tr>`)}</tbody></table></div>`
          : empty('No cases match these filters.')
      }
      ${section(
        'Import candidate cases',
        postForm(
          '/cases/import',
          ctx.csrf,
          html`<p class="muted small">A JSON file with one case, a list of cases, or {"cases": [...]}, in the evaluation-case format (see Settings / Data). Imported cases always start as candidates.</p>
          <input type="file" name="file" accept="application/json,.json" required> ${button('Import cases', 'secondary')}`,
          { multipart: true },
        ),
      )}`;
    render(req, res, ctx, { title: 'Evaluation Library', intro: 'Every evaluation case, from draft candidates to frozen benchmarks, with search and filters.', active: 'cases', body });
  });

  router.get('/cases/new', (req, res) => {
    const lab = ctx.store.snapshot();
    const observation = queryText(req, 'observation') ? findObservation(lab, queryText(req, 'observation')) : undefined;
    const draft: Partial<EvaluationCase> = {
      specialistId: queryText(req, 'specialist') || observation?.specialistId || latestProfiles(lab)[0]?.id,
      task: observation ? `Based on an observation: ${observation.whatHappened}` : '',
      limitations: '',
      methods: ['manual'],
    };
    render(req, res, ctx, {
      title: 'New case',
      intro: 'Write a candidate case. You can save it incomplete and validate it later.',
      active: 'cases',
      body: caseForm(lab, ctx.csrf, observation ? `/cases?observation=${observation.id}` : '/cases', draft, [], 'Save candidate'),
    });
  });

  router.post('/cases', upload.any(), csrfCheck, async (req, res) => {
    const lab = ctx.store.snapshot();
    const { changes, errors } = await caseFromForm(req, ctx, null);
    if (errors.length) {
      render(req, res, ctx, { title: 'New case', intro: 'Write a candidate case.', active: 'cases', body: caseForm(lab, ctx.csrf, '/cases', changes, errors, 'Save candidate') }, HTTP.badRequest);
      return;
    }
    const at = nowIso();
    const id = `${changes.specialistId ?? 'case'}-${slug(changes.title ?? '')}-${newId('x').slice(-ID_SUFFIX_LENGTH)}`;
    const created = CaseSchema.parse({
      ...changes,
      schema: 'eval-lab/evaluation-case',
      schemaVersion: FORMAT_VERSION,
      id,
      version: 1,
      status: 'candidate',
      provenance: { origin: 'user', source: queryText(req, 'observation') ? 'observation' : 'manual-entry' },
      changeNote: text(bodyOf(req), 'changeNote'),
      createdAt: at,
    });
    await ctx.store.add('cases', created);
    const observation = findObservation(lab, queryText(req, 'observation'));
    if (observation) await ctx.store.replace('observations', { ...observation, candidateCaseId: created.id });
    redirectDone(res, `/cases/${created.id}/v/1`, observation ? 'observation-candidate' : 'case-created');
  });

  router.post('/cases/import', jsonUpload.single('file'), csrfCheck, async (req, res) => {
    const file = req.file;
    if (!file) throw new LifecycleError('Choose a JSON file to import');
    const list = casesInFile(parseJsonFile(file.buffer));
    const lab = ctx.store.snapshot();
    const at = nowIso();
    const outcomes = list.map((raw, index): EvaluationCase | string => {
      const result = CaseSchema.safeParse(raw, { reportInput: true });
      if (!result.success) return `Case ${index + 1}: ${describeZodError(result.error)}`;
      if (latestCase(lab, result.data.id)) return `Case ${index + 1} ("${result.data.id}"): a case with this id already exists; it was not imported.`;
      return {
        ...result.data,
        version: 1,
        status: 'candidate',
        profileVersion: result.data.profileVersion ?? latestProfile(lab, result.data.specialistId)?.version ?? null,
        validation: null,
        freeze: null,
        previousVersion: null,
        provenance: { origin: 'user', source: 'file-import', sourceFile: file.originalname.slice(0, FILE_NAME_MAX), importedAt: at, note: '' },
      };
    });
    const accepted = outcomes.filter((o): o is EvaluationCase => typeof o !== 'string');
    await ctx.store.addMany('cases', accepted);
    const problems = outcomes.filter((o): o is string => typeof o === 'string');
    render(req, res, ctx, {
      title: 'Import cases',
      intro: 'The result of importing candidate cases from a file.',
      active: 'cases',
      body: html`<p>${accepted.length} case(s) imported as candidates.</p>${problems.length ? html`<div class="alert alert-warn"><strong>Not imported:</strong><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}${linkButton('/cases?status=candidate', 'See candidates', 'primary')}`,
    });
  });

  router.get('/cases/:id', (req, res) => {
    const latest = latestCase(ctx.store.snapshot(), idParam(req, 'id'));
    if (!latest) throw new NotFoundError('That case');
    res.redirect(HTTP.seeOther, `/cases/${latest.id}/v/${latest.version}`);
  });

  const loadCase = (req: Request): EvaluationCase => {
    const found = findCase(ctx.store.snapshot(), idParam(req, 'id'), versionParam(req));
    if (!found) throw new NotFoundError('That case version');
    return found;
  };

  router.get('/cases/:id/v/:version', (req, res) => {
    const c = loadCase(req);
    render(req, res, ctx, { title: c.title, intro: 'One evaluation case: what it tests, how it is judged, and where it is in its lifecycle.', active: 'cases', body: caseDetail(c, ctx.store.snapshot(), ctx.csrf) });
  });

  router.get('/cases/:id/v/:version/test-input.json', (req, res) => {
    const c = loadCase(req);
    res.setHeader('Content-Disposition', `attachment; filename="${c.id}-v${c.version}-test-input.json"`);
    res.type('application/json').send(JSON.stringify(testInputFor(c), null, JSON_INDENT));
  });

  router.get('/cases/:id/v/:version/edit', (req, res) => {
    const c = loadCase(req);
    const frozen = c.status === 'frozen' || c.status === 'evaluated';
    render(req, res, ctx, {
      title: `Edit: ${c.title}`,
      intro: frozen ? 'This version is frozen, so saving creates a new candidate version; the frozen version and its results stay unchanged.' : 'Change this draft. Validated cases return to candidate and must be validated again.',
      active: 'cases',
      body: caseForm(ctx.store.snapshot(), ctx.csrf, `/cases/${c.id}/v/${c.version}/edit`, c, [], frozen ? 'Save as new version' : 'Save changes'),
    });
  });

  router.post('/cases/:id/v/:version/edit', upload.any(), csrfCheck, async (req, res) => {
    const c = loadCase(req);
    const lab = ctx.store.snapshot();
    const { changes, errors } = await caseFromForm(req, ctx, c);
    if (errors.length) {
      render(req, res, ctx, { title: `Edit: ${c.title}`, intro: 'Fix the problems below.', active: 'cases', body: caseForm(lab, ctx.csrf, `/cases/${c.id}/v/${c.version}/edit`, { ...c, ...changes }, errors, 'Save') }, HTTP.badRequest);
      return;
    }
    const latestVersion = latestCase(lab, c.id)?.version ?? c.version;
    const outcome = editCase(c, changes, latestVersion, text(bodyOf(req), 'changeNote'));
    if (outcome.newVersion) await ctx.store.add('cases', outcome.case);
    else await ctx.store.replace('cases', outcome.case);
    redirectDone(res, `/cases/${outcome.case.id}/v/${outcome.case.version}`, outcome.newVersion ? 'case-new-version' : 'case-saved');
  });

  router.post('/cases/:id/v/:version/validate', csrfCheck, async (req, res) => {
    const c = loadCase(req);
    const validated = validateCase(c, profileForCase(ctx.store.snapshot(), c), ctx.owner, text(bodyOf(req), 'notes'));
    await ctx.store.replace('cases', validated);
    redirectDone(res, `/cases/${c.id}/v/${c.version}`, 'case-validated');
  });

  router.post('/cases/:id/v/:version/freeze', csrfCheck, async (req, res) => {
    const c = loadCase(req);
    const frozen = freezeCase(c, ctx.owner);
    await ctx.store.replace('cases', frozen);
    redirectDone(res, `/cases/${c.id}/v/${c.version}`, 'case-frozen');
  });

  router.post('/cases/:id/archive', csrfCheck, async (req, res) => {
    const id = idParam(req, 'id');
    const versions = caseVersions(ctx.store.snapshot(), id);
    if (!versions.length) throw new NotFoundError('That case');
    const archive = !versions[0]?.archived;
    await versions.reduce(async (previous, v) => {
      await previous;
      await ctx.store.replace('cases', { ...v, archived: archive });
    }, Promise.resolve());
    redirectDone(res, `/cases/${id}`, archive ? 'case-archived' : 'case-restored');
  });

  return router;
}

/** Used by tests: the hash a case would get when frozen. */
export const previewHash = caseContentHash;
