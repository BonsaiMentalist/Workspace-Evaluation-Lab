/* eslint-disable ts-patterns/no-magic-numbers -- WCAG constants are standard literals */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_DIR } from '../src/paths.js';
import { testLab } from './helpers.js';

const themeCss = readFileSync(join(PUBLIC_DIR, 'theme.css'), 'utf8');
const styleCss = readFileSync(join(PUBLIC_DIR, 'style.css'), 'utf8');

function tokens(theme: string): Record<string, string> {
  const start = themeCss.indexOf(`[data-theme='${theme}']`);
  const block = themeCss.slice(themeCss.indexOf('{', start) + 1, themeCss.indexOf('}', start));
  return Object.fromEntries(
    block
      .split(';')
      .map((line) => line.trim().split(':').map((part) => part.trim()))
      .filter(([name, value]) => name?.startsWith('--') && value?.startsWith('#'))
      .map(([name, value]) => [name?.slice(2) ?? '', value ?? '']),
  );
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

const TEXT_PAIRS = [
  ['text', 'bg'], ['text', 'surface'], ['text', 'surface-2'], ['text-muted', 'bg'], ['text-muted', 'surface'], ['text-muted', 'surface-2'],
  ['link', 'bg'], ['link', 'surface'], ['on-accent', 'accent'], ['on-accent', 'accent-hover'], ['good-fg', 'good-bg'], ['bad-fg', 'bad-bg'],
  ['warn-fg', 'warn-bg'], ['info-fg', 'info-bg'], ['neutral-fg', 'neutral-bg'], ['accent-fg', 'accent-bg'], ['on-danger', 'danger'], ['text', 'code-bg'],
] as const;

describe('theme', () => {
  it.each(['dark', 'light'].flatMap((theme) => TEXT_PAIRS.map(([fg, bg]) => ({ theme, fg, bg }))))('$theme: $fg on $bg meets WCAG AA', ({ theme, fg, bg }) => {
    const t = tokens(theme);
    expect(contrast(t[fg] ?? '', t[bg] ?? '')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps every colour in the theme file', () => {
    // A colour value: hex, rgb()/rgba() or hsl()/hsla(). Matches "color: #1b1916;"; rejects "color: var(--text);".
    // https://regex101.com/?flavor=javascript&regex=%23%5B0-9a-fA-F%5D%7B3%2C8%7D%5Cb%7Crgba%3F%5C(%7Chsla%3F%5C(&flags=g&testString=color%3A%20%231b1916%3B%0Acolor%3A%20var(--text)%3B
    expect(styleCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  it('defaults to dark whatever the system prefers, and switches to light only when chosen', async () => {
    const lab = await testLab(false);
    expect((await lab.agent.get('/').set('Sec-CH-Prefers-Color-Scheme', 'light')).text).toContain('data-theme="dark"');
    expect((await lab.agent.get('/').set('Cookie', 'theme=light')).text).toContain('data-theme="light"');
    expect((await lab.agent.get('/').set('Cookie', 'theme=<script>')).text).toContain('data-theme="dark"');
  });
});

describe('plain-language pages', () => {
  it.each(['/', '/cases', '/profiles', '/evaluate', '/review', '/compare', '/history', '/observations', '/data'])('%s opens with a one-sentence explanation before anything else', async (path) => {
    const lab = await testLab();
    const page = (await lab.agent.get(path)).text;
    const main = page.slice(page.indexOf('<main'));
    // The page heading followed directly by a one-sentence intro ending in a full stop.
    // Matches "<h1>History</h1> <p class=\"intro\">Past evaluations over time, sorted.</p>"; rejects "<h1>History</h1><table>".
    // https://regex101.com/?flavor=javascript&regex=%3Ch1%3E%5B%5E%3C%5D%2B%3C%5C%2Fh1%3E%5Cs*%3Cp%20class%3D%22intro%22%3E%5B%5E%3C%5D%7B20%2C%7D%5C.%3C%5C%2Fp%3E&flags=&testString=%3Ch1%3EHistory%3C%2Fh1%3E%20%3Cp%20class%3D%22intro%22%3EPast%20evaluations%20over%20time%2C%20sorted.%3C%2Fp%3E%0A%3Ch1%3EHistory%3C%2Fh1%3E%3Ctable%3E
    expect(main).toMatch(/<h1>[^<]+<\/h1>\s*<p class="intro">[^<]{20,}\.<\/p>/);
  });

  it('labels synthetic examples apart from the owner’s data', async () => {
    const lab = await testLab();
    expect((await lab.agent.get('/cases')).text).toContain('Synthetic example');
  });
});
