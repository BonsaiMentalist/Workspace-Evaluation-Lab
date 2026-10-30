/** View fragments shared by several pages. */
import type { Criterion, EvaluationCase, EvaluationResult, Finding, SavedOutput, SpecialistProfile } from '../domain/schemas.js';
import { STATUS_LABELS } from '../domain/cases.js';
import { assessedBy, OVERALL_EXPLANATIONS, scoreFindings, shareAsPercent } from '../domain/scoring.js';
import {
  badge,
  definitionList,
  empty,
  html,
  imageTag,
  known,
  outcomeBadge,
  overallBadge,
  prose,
  reviewBadge,
  shortDate,
  sourceBadge,
  tip,
  type SafeHtml,
} from './html.js';

export const TIPS = {
  heldOut: 'Held-out cases are kept back for final checks and never used while tuning instructions or choosing settings.',
  frozen: 'A frozen case has fixed test conditions. It can no longer be edited; editing makes a new version.',
  blinded: 'Blinded means the outputs are shown as A, B… with model and configuration hidden until you record your preference.',
  spotCheck: 'A spot-check is you looking at an imported assessment and accepting, correcting or rejecting it.',
  mandatory: 'A mandatory criterion must pass. If it fails, the result is a critical failure, whatever else went well.',
  core: 'Core criteria decide the overall outcome. Optional criteria are reported but cannot cause a failure on their own.',
  deterministic: 'Automatic checks look for exact things such as a required phrase or label. They cannot judge meaning or correctness.',
  equivalent: 'Equivalent conditions means the outputs were tested in the same way, so a difference is more likely to come from what you are comparing.',
  provenance: 'Provenance is where a record came from: typed in, imported from a file, or part of the synthetic examples.',
  rubric: 'The rubric is the profile version (the list of criteria) an output was judged against.',
  weighted: 'The share of assessed criteria met, weighted by importance. It is shown for context and never overrides a critical failure.',
  capability: 'A capability is a group of criteria reported on its own, such as canon management versus literary prose.',
  knownFailure: 'A known failure is already tracked, so it is not counted as a new problem.',
  fingerprint: 'A fingerprint is a short code that changes whenever the configuration changes.',
} as const;

const STATUS_TONES = { candidate: 'neutral', validated: 'info', frozen: 'accent', evaluated: 'good' } as const;

export const caseStatusBadge = (c: EvaluationCase): SafeHtml =>
  html`${badge(STATUS_TONES[c.status], STATUS_LABELS[c.status])}${c.archived ? html` ${badge('neutral', 'Archived')}` : ''}`;

export const splitBadge = (c: Pick<EvaluationCase, 'split'>): SafeHtml =>
  c.split === 'held-out' ? html`${badge('warn', 'Held-out')} ${tip(TIPS.heldOut)}` : html``;

export const caseLink = (c: Pick<EvaluationCase, 'id' | 'version' | 'title'>): SafeHtml => html`<a href="/cases/${c.id}/v/${c.version}">${c.title}</a>`;

export function modelLine(o: Pick<SavedOutput, 'producedBy' | 'configuration'>): SafeHtml {
  const m = o.producedBy;
  return html`${known(m.model)}${m.effort ? html` · effort ${m.effort}` : ''}${m.provider ? html` · ${m.provider}` : ''}${o.configuration.configurationId ? html` · ${o.configuration.configurationId}` : ''}`;
}

function ratingText(f: Finding): string {
  return f.rating ? ` (${f.rating.value} on ${f.rating.min}–${f.rating.max})` : '';
}

export function findingsTable(profile: SpecialistProfile, findings: readonly Finding[], original: readonly Finding[] | null = null): SafeHtml {
  const byId = new Map(findings.map((f) => [f.criterionId, f]));
  const originalById = new Map((original ?? []).map((f) => [f.criterionId, f]));
  const capabilityName = new Map(profile.capabilities.map((c) => [c.id, c]));
  const row = (c: Criterion): SafeHtml => {
    const f = byId.get(c.id);
    const before = originalById.get(c.id);
    // Also shown when the owner removed a finding the reviewer had made (set it back to "not assessed").
    const corrected = Boolean(before) && (!f || f.correctedByOwner);
    return html`<tr>
      <td><strong>${c.name}</strong>${c.mandatory ? html` ${badge('accent', 'Mandatory')}` : ''}${c.tier === 'optional' ? html` ${badge('neutral', 'Optional')}` : ''}
        ${capabilityName.get(c.capability)?.optional ? html`<div class="muted small">${capabilityName.get(c.capability)?.name}</div>` : ''}</td>
      <td>${f ? html`${outcomeBadge(f.outcome)}${ratingText(f)}` : outcomeBadge('not-assessed')}</td>
      <td>${f ? html`<div class="prose small">${f.explanation || '—'}</div>${f.evidenceRefs.length ? html`<div class="muted small">Evidence: ${f.evidenceRefs.join(', ')}</div>` : ''}` : ''}
        ${corrected && before ? html`<div class="original small"><strong>Reviewer originally said:</strong> ${outcomeBadge(before.outcome)}${ratingText(before)} — ${before.explanation || '—'}</div>` : ''}</td>
    </tr>`;
  };
  const extra = findings.filter((f) => !profile.criteria.some((c) => c.id === f.criterionId));
  return html`<div class="table-wrap"><table>
    <thead><tr><th scope="col">Criterion</th><th scope="col">Finding</th><th scope="col">Explanation and evidence</th></tr></thead>
    <tbody>${profile.criteria.map(row)}</tbody></table></div>
    ${extra.length ? html`<p class="muted small">Findings for criteria not in this rubric version were ignored: ${extra.map((f) => f.criterionId).join(', ')}.</p>` : ''}`;
}

/** Overall outcome first (with any critical failures spelled out), then each capability on its own. */
export function scoreSummaryView(profile: SpecialistProfile, findings: readonly Finding[]): SafeHtml {
  const s = scoreFindings(profile, findings);
  const caps = s.capabilities.map((cap) => {
    const percent = shareAsPercent(cap.weightedShare);
    return html`<li><strong>${cap.name}</strong>${cap.optional ? html` ${badge('neutral', 'Optional, reported separately')}` : ''}:
      ${cap.counts.pass} passed, ${cap.counts.partial} partly met, ${cap.counts.fail} failed, ${cap.counts.inconclusive} inconclusive,
      ${cap.counts['not-applicable']} not applicable, ${cap.counts['not-assessed']} not assessed.
      ${percent === null ? '' : html`<span class="muted">Weighted share met: ${percent}% ${tip(TIPS.weighted)}</span>`}</li>`;
  });
  return html`<div class="score">
    <p class="overall">${overallBadge(s.overall)} <span>${OVERALL_EXPLANATIONS[s.overall]}</span></p>
    ${s.criticalFailures.length ? html`<div class="alert alert-bad"><strong>Critical failure:</strong> ${s.criticalFailures.map((c) => c.name).join(', ')} ${tip(TIPS.mandatory)}</div>` : ''}
    <ul class="caps">${caps}</ul>
  </div>`;
}

export function resultRow(r: EvaluationResult, caseTitle: string, extra: SafeHtml = html``): SafeHtml {
  return html`<tr>
    <td class="nowrap"><a href="/results/${r.id}">${shortDate(r.createdAt)}</a></td>
    <td>${caseTitle}</td>
    <td class="nowrap">${known(r.model.model)}</td>
    <td>${sourceBadge(assessedBy(r))} ${reviewBadge(r.review.state)}</td>
    <td>${overallBadge(r.overall)}</td>
    ${extra}
  </tr>`;
}

export function resultsTable(results: readonly EvaluationResult[], caseTitle: (r: EvaluationResult) => string, emptyText: string): SafeHtml {
  if (!results.length) return empty(emptyText);
  return html`<div class="table-wrap"><table>
    <thead><tr><th scope="col">Recorded</th><th scope="col">Case</th><th scope="col">Model</th><th scope="col">Assessed by</th><th scope="col">Outcome</th></tr></thead>
    <tbody>${results.map((r) => resultRow(r, caseTitle(r)))}</tbody></table></div>`;
}

export function outputBody(o: SavedOutput): SafeHtml {
  return html`<div class="output-text">${prose(o.text)}</div>
    ${o.toolArtifacts.map(
      (a) => html`<figure class="artifact"><figcaption>Made by tool: <strong>${a.tool.name}</strong>${a.tool.model ? html` (${a.tool.model})` : ''} ${badge('info', 'Tool output, judged separately from the agent')}</figcaption>
        ${a.attachment ? imageTag(a.attachment.store, a.attachment.name, a.attachment.alt || a.description) : prose(a.text)}
        ${a.description ? html`<p class="muted small">${a.description}</p>` : ''}</figure>`,
    )}`;
}

export function outputFacts(o: SavedOutput): SafeHtml {
  const t = o.resources.tokens;
  return definitionList([
    ['Model', known(o.producedBy.model)],
    ['Provider', known(o.producedBy.provider)],
    ['Effort', known(o.producedBy.effort)],
    ['Configuration', known(o.configuration.configurationId)],
    ['Fingerprint', html`${known(o.configuration.fingerprint)} ${tip(TIPS.fingerprint)}`],
    ['Context configuration', known(o.configuration.contextConfigId)],
    ['Tools', o.configuration.toolConfigIds.length ? o.configuration.toolConfigIds.join(', ') : known(null)],
    ['Workspace job', o.workspace.job ? html`${o.workspace.job}${o.workspace.piece === null ? '' : html` · piece ${o.workspace.piece}`}` : known(null)],
    ['Workspace reply', o.workspace.reply ? html`${o.workspace.reply}${o.workspace.chat ? html` · chat ${o.workspace.chat}` : ''}` : known(null)],
    [
      'Tokens',
      t
        ? html`new ${known(t.uncached)} · cache write ${known(t.cacheWrite)} · cache read ${known(t.cacheRead)} · output ${known(t.output)} · thinking ${known(t.thinking)}`
        : known(null),
    ],
    ['Duration (seconds)', known(o.resources.durationS)],
    ['Measurements from', o.resources.provenance.source],
  ]);
}

export const contextView = (c: EvaluationCase): SafeHtml =>
  c.context.length
    ? html`${c.context.map(
        (item) => html`<details class="context-item"${c.context.length === 1 ? html` open` : ''}><summary><strong>${item.title}</strong>${item.authoritative ? html` ${badge('accent', 'Authoritative')}` : ''} <span class="muted small">${item.id}</span></summary>
          ${item.attachment ? imageTag(item.attachment.store, item.attachment.name, item.attachment.alt || item.title) : ''}${item.text ? prose(item.text) : ''}${item.note ? html`<p class="muted small">${item.note}</p>` : ''}</details>`,
      )}${c.contextNote ? prose(c.contextNote) : ''}`
    : prose(c.contextNote);
