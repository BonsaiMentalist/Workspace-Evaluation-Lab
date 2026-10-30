/**
 * HTML building blocks. `html` escapes every interpolated value unless it is
 * already `SafeHtml`, so stored or imported text can never become markup or
 * script. Pages are built only from these helpers; there is no raw string
 * concatenation of user data into HTML.
 */
import type { EvaluatorType, Origin, Outcome, OverallStatus, Privacy, ReviewState } from '../domain/schemas.js';
import { OUTCOME_LABELS, OVERALL_LABELS, REVIEW_STATE_LABELS, ASSESSED_BY_LABELS, type AssessedBy, type OutcomeOrMissing } from '../domain/scoring.js';

export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

type Interpolation = SafeHtml | string | number | boolean | null | undefined | readonly Interpolation[];

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
// Characters that are special in HTML text or attributes. "<b>" → "&lt;b&gt;"; "plain" is unchanged.
// https://regex101.com/?flavor=javascript&regex=%5B%26%3C%3E%22'%60%5D&flags=g&testString=%3Cb%3E%0Aplain
const HTML_SPECIAL = /[&<>"'`]/g;

export function escapeHtml(value: string): string {
  return value.replace(HTML_SPECIAL, (c) => ESCAPES[c] ?? c);
}

function render(value: Interpolation): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Interpolation[]): SafeHtml {
  return new SafeHtml(strings.reduce((out, chunk, i) => out + chunk + (i < values.length ? render(values[i]) : ''), ''));
}

/** Joins fragments without escaping them again. */
export const join = (parts: readonly SafeHtml[], separator = ''): SafeHtml => new SafeHtml(parts.map((p) => p.value).join(separator));

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

/** A small ⓘ that explains an unavoidable term in one line, readable by keyboard and screen reader. */
export const tip = (text: string): SafeHtml =>
  html`<span class="tip" tabindex="0" role="note" aria-label="${text}" data-tip="${text}">ⓘ</span>`;

type Tone = 'good' | 'bad' | 'warn' | 'neutral' | 'info' | 'accent';

export const badge = (tone: Tone, text: string, title = ''): SafeHtml => html`<span class="badge badge-${tone}"${title ? html` title="${title}"` : ''}>${text}</span>`;

const OUTCOME_TONES = {
  pass: 'good',
  partial: 'warn',
  fail: 'bad',
  inconclusive: 'info',
  'not-applicable': 'neutral',
  'not-assessed': 'neutral',
} as const satisfies Record<OutcomeOrMissing, Tone>;

const OVERALL_TONES = {
  'critical-failure': 'bad',
  fail: 'bad',
  'pass-with-issues': 'warn',
  pass: 'good',
  inconclusive: 'info',
  incomplete: 'neutral',
} as const satisfies Record<OverallStatus, Tone>;

const REVIEW_TONES = {
  'not-required': 'neutral',
  'needs-spot-check': 'accent',
  accepted: 'good',
  corrected: 'info',
  rejected: 'bad',
} as const satisfies Record<ReviewState, Tone>;

export const outcomeBadge = (o: Outcome | OutcomeOrMissing): SafeHtml => badge(OUTCOME_TONES[o], OUTCOME_LABELS[o]);
export const overallBadge = (o: OverallStatus | null): SafeHtml => (o ? badge(OVERALL_TONES[o], OVERALL_LABELS[o]) : badge('neutral', 'Not scored'));
export const reviewBadge = (s: ReviewState): SafeHtml => (s === 'not-required' ? html`` : badge(REVIEW_TONES[s], REVIEW_STATE_LABELS[s]));
export const sourceBadge = (s: AssessedBy): SafeHtml => html`<span class="source source-${s}">${ASSESSED_BY_LABELS[s]}</span>`;

export const originBadge = (origin: Origin): SafeHtml =>
  origin === 'synthetic'
    ? html`<span class="origin origin-synthetic" title="Made-up example data shipped with the lab">Synthetic example</span>`
    : html`<span class="origin origin-user" title="Data you created or imported; it stays on this computer">Your data</span>`;

const PRIVACY_LABELS = {
  synthetic: 'Made-up example',
  'local-private': 'Private – stays on this computer',
  shareable: 'Safe to share',
} as const satisfies Record<Privacy, string>;
export const privacyLabel = (p: Privacy): string => PRIVACY_LABELS[p];

const EVALUATOR_TYPE_LABELS = {
  human: 'Person',
  'ai-reviewer': 'AI reviewer',
  'deterministic-check': 'Automatic check',
  'executable-runner': 'Test runner',
  'ai-judge': 'AI judge',
} as const satisfies Record<EvaluatorType, string>;
export const evaluatorTypeLabel = (t: EvaluatorType): string => EVALUATOR_TYPE_LABELS[t];

const DATE_LENGTH = 10;
const DATETIME_LENGTH = 16;
export const shortDate = (iso: string | null): string => (iso ? iso.slice(0, DATE_LENGTH) : 'unknown');
export const shortDateTime = (iso: string | null): string => (iso ? iso.slice(0, DATETIME_LENGTH).replace('T', ' ') : 'unknown');

/** Shows a value or the word "unknown" — never a made-up zero. */
export const known = (value: string | number | null | undefined): SafeHtml =>
  value === null || value === undefined || value === '' ? html`<span class="unknown">unknown</span>` : html`${value}`;

export const csrfField = (token: string): SafeHtml => html`<input type="hidden" name="_csrf" value="${token}">`;

/** A form that posts to the lab with its CSRF token. */
export function postForm(action: string, csrf: string, body: SafeHtml, opts: { readonly multipart?: boolean; readonly cls?: string } = {}): SafeHtml {
  return html`<form method="post" action="${action}"${opts.multipart ? html` enctype="multipart/form-data"` : ''}${opts.cls ? html` class="${opts.cls}"` : ''}>${csrfField(csrf)}${body}</form>`;
}

export const button = (label: string, kind: 'primary' | 'secondary' | 'danger' = 'primary', name = '', value = ''): SafeHtml =>
  html`<button type="submit" class="btn btn-${kind}"${name ? html` name="${name}" value="${value}"` : ''}>${label}</button>`;

export const linkButton = (href: string, label: string, kind: 'primary' | 'secondary' = 'secondary'): SafeHtml => html`<a class="btn btn-${kind}" href="${href}">${label}</a>`;

export const empty = (text: string): SafeHtml => html`<p class="empty">${text}</p>`;

export const errorList = (errors: readonly string[]): SafeHtml =>
  errors.length ? html`<div class="alert alert-bad" role="alert"><strong>Please fix the following:</strong><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : html``;

/** Multi-line text shown with its line breaks, still escaped. */
export const prose = (text: string): SafeHtml => (text.trim() ? html`<div class="prose">${text}</div>` : html`<p class="muted">None given.</p>`);

export const section = (title: string, body: SafeHtml, extra: SafeHtml = html``): SafeHtml =>
  html`<section class="card"><div class="card-head"><h2>${title}</h2>${extra}</div>${body}</section>`;

export function definitionList(rows: ReadonlyArray<readonly [string, SafeHtml | string | number | null]>): SafeHtml {
  return html`<dl class="facts">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v instanceof SafeHtml ? v : known(v)}</dd>`)}</dl>`;
}

export const imageTag = (store: string, name: string, alt: string): SafeHtml =>
  html`<img class="evidence-image" src="/attachments/${store}/${name}" alt="${alt || 'Image'}" loading="lazy">`;

// ---------------------------------------------------------------------------
// Page layout
// ---------------------------------------------------------------------------

export type Theme = 'dark' | 'light';
export type NavKey = 'overview' | 'cases' | 'profiles' | 'evaluate' | 'review' | 'compare' | 'history' | 'observations' | 'data';

const NAV: ReadonlyArray<readonly [NavKey, string, string]> = [
  ['overview', '/', 'Overview'],
  ['cases', '/cases', 'Evaluation Library'],
  ['profiles', '/profiles', 'Specialist Profiles'],
  ['evaluate', '/evaluate', 'Evaluate'],
  ['review', '/review', 'Spot-check'],
  ['compare', '/compare', 'Compare'],
  ['history', '/history', 'History'],
  ['observations', '/observations', 'Observations'],
  ['data', '/data', 'Settings / Data'],
];

export interface PageOptions {
  readonly title: string;
  /** One plain sentence saying what the page is for, shown before anything else. */
  readonly intro: string;
  readonly active: NavKey;
  readonly theme: Theme;
  readonly csrf: string;
  readonly body: SafeHtml;
  readonly notice?: string | null;
  readonly reviewCount?: number;
  readonly currentPath: string;
}

export function page(o: PageOptions): SafeHtml {
  const nextTheme: Theme = o.theme === 'dark' ? 'light' : 'dark';
  const nav = NAV.map(
    ([key, href, label]) =>
      html`<li><a href="${href}"${key === o.active ? html` aria-current="page"` : ''}>${label}${key === 'review' && o.reviewCount ? html` <span class="count">${o.reviewCount}</span>` : ''}</a></li>`,
  );
  return html`<!doctype html>
<html lang="en" data-theme="${o.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${o.title} · Specialist Evaluation Lab</title>
<link rel="stylesheet" href="/static/theme.css">
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <div class="brand"><span class="brand-mark" aria-hidden="true">◆</span> Specialist Evaluation Lab <span class="local-pill" title="Everything stays on this computer">Local only</span></div>
  ${postForm('/theme', o.csrf, html`<input type="hidden" name="theme" value="${nextTheme}"><input type="hidden" name="back" value="${o.currentPath}">${button(nextTheme === 'light' ? 'Light theme' : 'Dark theme', 'secondary')}`, { cls: 'theme-form' })}
</header>
<div class="layout">
<nav class="sidenav" aria-label="Main"><ul>${nav}</ul></nav>
<main id="main">
<h1>${o.title}</h1>
<p class="intro">${o.intro}</p>
${o.notice ? html`<div class="alert alert-good" role="status">${o.notice}</div>` : ''}
${o.body}
</main>
</div>
</body>
</html>`;
}
