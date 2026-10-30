/** The criterion-by-criterion scoring form, used for manual scoring and for correcting imported assessments. */
import type { Finding, Outcome, SpecialistProfile } from '../../domain/schemas.js';
import { Outcome as OutcomeSchema } from '../../domain/schemas.js';
import { OUTCOME_LABELS } from '../../domain/scoring.js';
import { badge, html, tip, type SafeHtml } from '../html.js';
import { commaList, longText, num, rows, text, type FormBody } from '../form.js';
import { TIPS } from '../views.js';

const OUTCOMES: readonly Outcome[] = ['pass', 'partial', 'fail', 'inconclusive', 'not-applicable'];
const NOT_ASSESSED = '';

export function findingsFields(profile: SpecialistProfile, initial: readonly Finding[]): SafeHtml {
  const byId = new Map(initial.map((f) => [f.criterionId, f]));
  return html`${profile.criteria.map((c, i) => {
    const f = byId.get(c.id);
    const radio = (value: string, label: string): SafeHtml =>
      html`<label class="check"><input type="radio" name="findings[${i}][outcome]" value="${value}"${(f?.outcome ?? NOT_ASSESSED) === value ? html` checked` : ''}> ${label}</label>`;
    return html`<fieldset class="criterion">
      <legend>${c.name} ${c.mandatory ? html`${badge('bad', 'Mandatory')} ${tip(TIPS.mandatory)}` : ''} ${c.tier === 'optional' ? badge('neutral', 'Optional') : ''}</legend>
      <input type="hidden" name="findings[${i}][criterionId]" value="${c.id}">
      ${c.description ? html`<p class="small muted">${c.description}</p>` : ''}
      ${c.guidance ? html`<details class="small"><summary>Rubric guidance</summary><div class="prose">${c.guidance}</div></details>` : ''}
      <div class="row radios">${OUTCOMES.map((o) => radio(o, OUTCOME_LABELS[o]))}${radio(NOT_ASSESSED, 'Not assessed')}</div>
      ${c.scale.kind === 'rating' ? html`<label>Rating (${c.scale.min}–${c.scale.max}${c.scale.anchors ? `; ${c.scale.anchors}` : ''}) <input name="findings[${i}][rating]" inputmode="decimal" value="${f?.rating?.value ?? ''}"></label>` : ''}
      <label>Explanation <textarea name="findings[${i}][explanation]" rows="2">${f?.explanation ?? ''}</textarea></label>
      <label>Evidence references (comma-separated, e.g. E1, E2) <input name="findings[${i}][evidence]" value="${(f?.evidenceRefs ?? []).join(', ')}"></label>
    </fieldset>`;
  })}`;
}

/** Findings from the form. Criteria left "not assessed" produce no finding. Ratings use the criterion's scale. */
export function findingsFromForm(body: FormBody, profile: SpecialistProfile): unknown[] {
  return rows(body, 'findings').flatMap((row) => {
    const criterion = profile.criteria.find((c) => c.id === text(row, 'criterionId'));
    const outcome = OutcomeSchema.safeParse(text(row, 'outcome'));
    if (!criterion || !outcome.success) return [];
    const ratingValue = num(row, 'rating');
    const rating = criterion.scale.kind === 'rating' && ratingValue !== null ? { value: ratingValue, min: criterion.scale.min, max: criterion.scale.max } : null;
    return [{ criterionId: criterion.id, outcome: outcome.data, rating, explanation: longText(row, 'explanation'), evidenceRefs: commaList(text(row, 'evidence')), method: 'manual' }];
  });
}
