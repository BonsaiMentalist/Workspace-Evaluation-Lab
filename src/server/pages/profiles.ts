/** Specialist Profiles: role-specific criteria, core versus optional, and versions. Edits always create a new version. */
import { Router, type Request, type RequestHandler } from 'express';
import type { Multer } from 'multer';
import type { Criterion, Method, SpecialistProfile } from '../../domain/schemas.js';
import { FORMAT_VERSION, Method as MethodSchema, SpecialistProfile as ProfileSchema } from '../../domain/schemas.js';
import { findProfile, latestProfile, latestProfiles, profileVersions, type LabSnapshot } from '../../domain/lookup.js';
import { describeZodError, schemaVersionProblem } from '../../domain/errors.js';
import { LifecycleError } from '../../domain/cases.js';
import { nowIso } from '../../domain/hash.js';
import { badge, button, empty, errorList, html, linkButton, originBadge, postForm, section, shortDate, tip, type SafeHtml } from '../html.js';
import { bodyOf, checkbox, int, longText, many, num, rows, text, type FormBody, parseJsonFile } from '../form.js';
import { idParam, NotFoundError, redirectDone, render, versionParam, type AppContext } from '../context.js';
import { TIPS } from '../views.js';
import { HTTP } from '../status.js';

const METHOD_NAMES = {
  deterministic: 'Automatic checks',
  manual: 'Manual assessment',
  'blinded-comparison': 'Blinded comparison',
  executable: 'Test runner',
} as const satisfies Record<Method, string>;
const ASSESSES_NAMES = { agent: 'The agent’s own work', 'tool-output': 'A tool’s output (e.g. a generated image)', combined: 'Both together' } as const;
const BLANK_CRITERIA = 2;
const BLANK_CAPABILITIES = 1;
const DEFAULT_RATING_MAX = 5;
const PROFILE_SCHEMA = 'eval-lab/specialist-profile';
const JSON_INDENT = 2;
// Characters other than lowercase letters and digits, collapsed to one dash: "Canon fidelity!" → "canon-fidelity-"; "abc" is unchanged.
// https://regex101.com/?flavor=javascript&regex=%5B%5Ea-z0-9%5D%2B&flags=g&testString=canon%20fidelity!%0Aabc
const NON_SLUG = /[^a-z0-9]+/g;
// Leading or trailing dashes: "-abc-" → "abc"; "abc" is unchanged.
// https://regex101.com/?flavor=javascript&regex=%5E-%2B%7C-%2B%24&flags=g&testString=-abc-%0Aabc
const EDGE_DASHES = /^-+|-+$/g;
const SLUG_MAX = 60;
const slug = (s: string): string => s.toLowerCase().replace(NON_SLUG, '-').replace(EDGE_DASHES, '').slice(0, SLUG_MAX);

function criteriaTable(p: SpecialistProfile): SafeHtml {
  return html`${p.capabilities.map((cap) => {
    const criteria = p.criteria.filter((c) => c.capability === cap.id);
    return html`<h3>${cap.name} ${cap.optional ? badge('neutral', 'Optional capability, reported separately') : ''} ${tip(TIPS.capability)}</h3>
      ${cap.description ? html`<p class="muted">${cap.description}</p>` : ''}
      <div class="table-wrap"><table><thead><tr><th scope="col">Criterion</th><th scope="col">Importance</th><th scope="col">How it is evaluated</th><th scope="col">Scale</th></tr></thead>
      <tbody>${criteria.map(
        (c) => html`<tr><td><strong>${c.name}</strong> <span class="muted small">${c.id}</span><div class="small">${c.description}</div>${c.guidance ? html`<details class="small"><summary>Rubric guidance</summary><div class="prose">${c.guidance}</div></details>` : ''}</td>
        <td>${c.tier === 'core' ? badge('accent', 'Core') : badge('neutral', 'Optional')} ${c.mandatory ? html`${badge('bad', 'Mandatory')} ${tip(TIPS.mandatory)}` : ''}<div class="small">Weight ${c.weight}</div></td>
        <td>${c.methods.map((m) => METHOD_NAMES[m]).join(', ')}<div class="small muted">Judges: ${ASSESSES_NAMES[c.assesses]}</div></td>
        <td>${c.scale.kind === 'rating' ? html`Rating ${c.scale.min}–${c.scale.max}${c.scale.anchors ? html`<div class="small muted">${c.scale.anchors}</div>` : ''}` : 'Pass / partly / fail'}</td></tr>`,
      )}</tbody></table></div>`;
  })}`;
}

function profileForm(csrf: string, action: string, p: Partial<SpecialistProfile>, errors: readonly string[], isNew: boolean): SafeHtml {
  const capabilities = [...(p.capabilities ?? [{ id: 'primary', name: 'Primary responsibility', description: '', optional: false }]), ...Array.from({ length: BLANK_CAPABILITIES }, () => null)];
  const criteria = [...(p.criteria ?? []), ...Array.from({ length: BLANK_CRITERIA }, () => null)];
  const capIds = (p.capabilities ?? []).map((c) => c.id);
  const option = (value: string, label: string, selected: boolean): SafeHtml => html`<option value="${value}"${selected ? html` selected` : ''}>${label}</option>`;
  const criterionRow = (c: Criterion | null, i: number): SafeHtml => html`<div class="subform">
    <div class="row"><label>Name <input name="criteria[${i}][name]" value="${c?.name ?? ''}"></label>
    <label>Id <input name="criteria[${i}][id]" value="${c?.id ?? ''}" placeholder="made from the name"></label>
    <label>Capability <select name="criteria[${i}][capability]">${(capIds.length ? capIds : ['primary']).map((id) => option(id, id, (c?.capability ?? 'primary') === id))}</select></label>
    ${c ? html`<label class="check"><input type="checkbox" name="criteria[${i}][remove]"> Remove</label>` : ''}</div>
    <label>What it means <textarea name="criteria[${i}][description]" rows="2">${c?.description ?? ''}</textarea></label>
    <div class="row">
      <label>Tier ${tip(TIPS.core)} <select name="criteria[${i}][tier]">${option('core', 'Core', c?.tier !== 'optional')}${option('optional', 'Optional', c?.tier === 'optional')}</select></label>
      <label class="check"><input type="checkbox" name="criteria[${i}][mandatory]"${c?.mandatory ? html` checked` : ''}> Mandatory ${tip(TIPS.mandatory)}</label>
      <label>Weight <input name="criteria[${i}][weight]" inputmode="decimal" value="${c?.weight ?? 1}"></label>
      <label>Judges <select name="criteria[${i}][assesses]">${(Object.keys(ASSESSES_NAMES) as Array<keyof typeof ASSESSES_NAMES>).map((k) => option(k, ASSESSES_NAMES[k], (c?.assesses ?? 'agent') === k))}</select></label>
    </div>
    <div class="row">${(Object.keys(METHOD_NAMES) as Method[]).map(
      (m) => html`<label class="check"><input type="checkbox" name="criteria[${i}][methods]" value="${m}"${(c?.methods ?? ['manual']).includes(m) ? html` checked` : ''}> ${METHOD_NAMES[m]}</label>`,
    )}</div>
    <div class="row"><label>Scale <select name="criteria[${i}][scale]">${option('outcome', 'Pass / partly / fail', c?.scale.kind !== 'rating')}${option('rating', 'Rating', c?.scale.kind === 'rating')}</select></label>
      <label>Rating from <input name="criteria[${i}][min]" inputmode="numeric" value="${c?.scale.kind === 'rating' ? c.scale.min : 1}"></label>
      <label>to <input name="criteria[${i}][max]" inputmode="numeric" value="${c?.scale.kind === 'rating' ? c.scale.max : DEFAULT_RATING_MAX}"></label>
      <label class="grow">What the rating points mean <input name="criteria[${i}][anchors]" value="${c?.scale.kind === 'rating' ? c.scale.anchors : ''}" placeholder="e.g. 1 = flat, 3 = competent, 5 = memorable"></label></div>
    <label>Rubric guidance <textarea name="criteria[${i}][guidance]" rows="2">${c?.guidance ?? ''}</textarea></label>
  </div>`;
  return postForm(
    action,
    csrf,
    html`${errorList(errors)}
    <fieldset><legend>Profile</legend>
      ${isNew ? html`<label>Id (letters, digits and dashes) <input name="id" required value="${p.id ?? ''}"></label>` : ''}
      <label>Name <input name="name" required value="${p.name ?? ''}"></label>
      <label>Purpose <textarea name="purpose" rows="2">${p.purpose ?? ''}</textarea></label>
      <label>What changed in this version <input name="changeNote" value=""></label>
    </fieldset>
    <fieldset><legend>Capabilities ${tip(TIPS.capability)}</legend>
      ${capabilities.map(
        (c, i) => html`<div class="row subform"><label>Id <input name="capabilities[${i}][id]" value="${c?.id ?? ''}"></label>
        <label>Name <input name="capabilities[${i}][name]" value="${c?.name ?? ''}"></label>
        <label class="grow">Description <input name="capabilities[${i}][description]" value="${c?.description ?? ''}"></label>
        <label class="check"><input type="checkbox" name="capabilities[${i}][optional]"${c?.optional ? html` checked` : ''}> Optional (reported separately)</label></div>`,
      )}
    </fieldset>
    <fieldset><legend>Criteria</legend>${criteria.map(criterionRow)}</fieldset>
    ${button('Save as new version')}`,
  );
}

function criterionFromRow(row: FormBody): Criterion | null {
  const name = text(row, 'name');
  if (!name || checkbox(row, 'remove')) return null;
  const isRating = text(row, 'scale') === 'rating';
  const methods = many(row, 'methods').filter((m): m is Method => MethodSchema.safeParse(m).success);
  return {
    id: text(row, 'id') || slug(name),
    name,
    description: longText(row, 'description'),
    tier: text(row, 'tier') === 'optional' ? 'optional' : 'core',
    mandatory: checkbox(row, 'mandatory'),
    capability: text(row, 'capability') || 'primary',
    methods: methods.length ? methods : ['manual'],
    weight: num(row, 'weight') ?? 1,
    assesses: (['agent', 'tool-output', 'combined'] as const).find((a) => a === text(row, 'assesses')) ?? 'agent',
    scale: isRating ? { kind: 'rating', min: int(row, 'min') ?? 1, max: int(row, 'max') ?? DEFAULT_RATING_MAX, anchors: text(row, 'anchors') } : { kind: 'outcome' },
    guidance: longText(row, 'guidance'),
  };
}

function profileFromForm(req: Request, id: string, version: number): { profile: unknown; draft: Partial<SpecialistProfile> } {
  const body = bodyOf(req);
  const capabilities = rows(body, 'capabilities')
    .filter((r) => text(r, 'id') && text(r, 'name'))
    .map((r) => ({ id: text(r, 'id'), name: text(r, 'name'), description: text(r, 'description'), optional: checkbox(r, 'optional') }));
  const criteria = rows(body, 'criteria').map(criterionFromRow).filter((c): c is Criterion => c !== null);
  const draft: Partial<SpecialistProfile> = { id, name: text(body, 'name'), purpose: longText(body, 'purpose'), capabilities, criteria };
  return {
    draft,
    profile: { ...draft, schema: PROFILE_SCHEMA, schemaVersion: FORMAT_VERSION, version, changeNote: text(body, 'changeNote'), createdAt: nowIso(), origin: 'user' },
  };
}

function profileList(lab: LabSnapshot): SafeHtml {
  const profiles = latestProfiles(lab);
  if (!profiles.length) return empty('No profiles yet.');
  return html`<div class="table-wrap"><table><thead><tr><th scope="col">Specialist</th><th scope="col">Criteria</th><th scope="col">Version</th><th scope="col">Origin</th></tr></thead><tbody>${profiles.map((p) => {
    const core = p.criteria.filter((c) => c.tier === 'core').length;
    const mandatory = p.criteria.filter((c) => c.mandatory).length;
    return html`<tr><td><a href="/profiles/${p.id}/v/${p.version}">${p.name}</a><div class="small muted">${p.purpose}</div></td>
      <td>${p.criteria.length} (${core} core, ${p.criteria.length - core} optional, ${mandatory} mandatory)</td><td>${p.version}</td><td>${originBadge(p.origin)}</td></tr>`;
  })}</tbody></table></div>`;
}

export function profileRoutes(ctx: AppContext, jsonUpload: Multer, csrfCheck: RequestHandler): Router {
  const router = Router();

  router.get('/profiles', (req, res) => {
    const body = html`<div class="toolbar">${linkButton('/profiles/new', 'New specialist profile', 'primary')}</div>
      ${profileList(ctx.store.snapshot())}
      ${section(
        'Import a profile',
        postForm(
          '/profiles/import',
          ctx.csrf,
          html`<p class="muted small">A JSON file in the specialist-profile format. If the specialist already exists it becomes that specialist’s next version.</p><input type="file" name="file" accept="application/json,.json" required> ${button('Import profile', 'secondary')}`,
          { multipart: true },
        ),
      )}`;
    render(req, res, ctx, { title: 'Specialist Profiles', intro: 'What each specialist is judged on: its criteria, which ones are core or mandatory, and every version of its rubric.', active: 'profiles', body });
  });

  router.get('/profiles/new', (req, res) => {
    render(req, res, ctx, { title: 'New specialist profile', intro: 'Describe a new specialist and the criteria it should be judged on.', active: 'profiles', body: profileForm(ctx.csrf, '/profiles', {}, [], true) });
  });

  const save = async (req: Request, id: string, isNew: boolean): Promise<SafeHtml | null> => {
    const lab = ctx.store.snapshot();
    const version = (latestProfile(lab, id)?.version ?? 0) + 1;
    const { profile, draft } = profileFromForm(req, id, version);
    const parsed = ProfileSchema.safeParse(profile);
    if (parsed.success && isNew && latestProfile(lab, id)) return profileForm(ctx.csrf, '/profiles', draft, [`A specialist with id "${id}" already exists.`], true);
    if (!parsed.success) return profileForm(ctx.csrf, isNew ? '/profiles' : `/profiles/${id}/edit`, draft, [describeZodError(parsed.error)], isNew);
    await ctx.store.add('profiles', parsed.data);
    return null;
  };

  router.post('/profiles', csrfCheck, async (req, res) => {
    const id = slug(text(bodyOf(req), 'id'));
    const problem = await save(req, id || 'specialist', true);
    if (problem) return render(req, res, ctx, { title: 'New specialist profile', intro: 'Fix the problems below.', active: 'profiles', body: problem }, HTTP.badRequest);
    redirectDone(res, `/profiles/${id}`, 'profile-saved');
  });

  router.post('/profiles/import', jsonUpload.single('file'), csrfCheck, async (req, res) => {
    if (!req.file) throw new LifecycleError('Choose a JSON file to import');
    const raw: unknown = parseJsonFile(req.file.buffer);
    const versionProblem = schemaVersionProblem(raw, PROFILE_SCHEMA, FORMAT_VERSION);
    if (versionProblem) throw new LifecycleError(versionProblem);
    const parsed = ProfileSchema.safeParse(raw, { reportInput: true });
    if (!parsed.success) throw new LifecycleError(`This is not a valid profile. ${describeZodError(parsed.error)}`);
    const next = (latestProfile(ctx.store.snapshot(), parsed.data.id)?.version ?? 0) + 1;
    await ctx.store.add('profiles', { ...parsed.data, version: next, origin: 'user', createdAt: nowIso() });
    redirectDone(res, `/profiles/${parsed.data.id}`, 'profile-saved');
  });

  router.get('/profiles/:id', (req, res) => {
    const p = latestProfile(ctx.store.snapshot(), idParam(req, 'id'));
    if (!p) throw new NotFoundError('That profile');
    res.redirect(HTTP.seeOther, `/profiles/${p.id}/v/${p.version}`);
  });

  router.get('/profiles/:id/v/:version', (req, res) => {
    const lab = ctx.store.snapshot();
    const p = findProfile(lab, idParam(req, 'id'), versionParam(req));
    if (!p) throw new NotFoundError('That profile version');
    const versions = profileVersions(lab, p.id);
    const isLatest = versions[0]?.version === p.version;
    const body = html`<div class="toolbar">${originBadge(p.origin)} ${badge('info', `Version ${p.version}`)}
        ${isLatest ? linkButton(`/profiles/${p.id}/edit`, 'Edit (creates a new version)') : badge('warn', 'Older version')}
        ${linkButton(`/profiles/${p.id}/v/${p.version}/profile.json`, 'Download as JSON')}</div>
      ${p.purpose ? html`<p>${p.purpose}</p>` : ''}
      ${section('Criteria', criteriaTable(p))}
      ${section('Versions', html`<ul class="plain">${versions.map((v) => html`<li><a href="/profiles/${v.id}/v/${v.version}">Version ${v.version}</a> · ${shortDate(v.createdAt)}${v.changeNote ? html` · ${v.changeNote}` : ''}</li>`)}</ul>
        <p class="muted small">Results always record the rubric version they used, so older results stay readable after a change. ${tip(TIPS.rubric)}</p>`)}`;
    render(req, res, ctx, { title: p.name, intro: 'The criteria this specialist is judged on, grouped by capability.', active: 'profiles', body });
  });

  router.get('/profiles/:id/v/:version/profile.json', (req, res) => {
    const p = findProfile(ctx.store.snapshot(), idParam(req, 'id'), versionParam(req));
    if (!p) throw new NotFoundError('That profile version');
    res.setHeader('Content-Disposition', `attachment; filename="${p.id}-v${p.version}.profile.json"`);
    res.type('application/json').send(JSON.stringify(p, null, JSON_INDENT));
  });

  router.get('/profiles/:id/edit', (req, res) => {
    const p = latestProfile(ctx.store.snapshot(), idParam(req, 'id'));
    if (!p) throw new NotFoundError('That profile');
    render(req, res, ctx, {
      title: `Edit: ${p.name}`,
      intro: `Saving creates version ${p.version + 1}. Version ${p.version} and every result recorded against it stay unchanged.`,
      active: 'profiles',
      body: profileForm(ctx.csrf, `/profiles/${p.id}/edit`, p, [], false),
    });
  });

  router.post('/profiles/:id/edit', csrfCheck, async (req, res) => {
    const id = idParam(req, 'id');
    if (!latestProfile(ctx.store.snapshot(), id)) throw new NotFoundError('That profile');
    const problem = await save(req, id, false);
    if (problem) return render(req, res, ctx, { title: 'Edit profile', intro: 'Fix the problems below.', active: 'profiles', body: problem }, HTTP.badRequest);
    redirectDone(res, `/profiles/${id}`, 'profile-saved');
  });

  return router;
}
