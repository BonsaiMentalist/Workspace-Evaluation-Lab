/* eslint-disable ts-patterns/no-magic-numbers -- HTTP status codes read more clearly as literals in tests */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { attachmentPath, detectImageType } from '../src/storage/attachments.js';
import { Id } from '../src/domain/schemas.js';
import { LISTEN_HOST } from '../src/server/listen.js';
import { createApp } from '../src/server/app.js';
import { escapeHtml, html } from '../src/server/html.js';
import { APP_ROOT, DEFAULT_DATA_DIR, FIXTURE_IMAGES_DIR } from '../src/paths.js';
import { CSRF, freshStore, post, testLab } from './helpers.js';

const PNG_BYTES = readFileSync(join(FIXTURE_IMAGES_DIR, 'outfit-before.png'));
const SVG_AS_PNG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('network boundaries', () => {
  it('listens on the loopback address only', () => {
    expect(LISTEN_HOST).toBe('127.0.0.1');
  });

  it.each(['evil.example', 'evil.example:4317', '192.168.1.20:4317', 'localhost.evil.example'])('refuses requests addressed to %s (DNS rebinding)', async (host) => {
    const lab = await testLab(false);
    const res = await lab.agent.get('/').set('Host', host);
    expect(res.status).toBe(421);
  });

  it.each(['localhost:4317', '127.0.0.1:4317', '[::1]:4317'])('serves requests addressed to %s', async (host) => {
    const lab = await testLab(false);
    expect((await lab.agent.get('/').set('Host', host)).status).toBe(200);
  });

  it('sends strict security headers on every page', async () => {
    const lab = await testLab(false);
    const res = await lab.agent.get('/');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('forms only work from the lab’s own pages', () => {
  it('refuses a change without the form token', async () => {
    const lab = await testLab();
    const res = await lab.agent.post('/cases/master-delegation-001/archive').type('form').send({});
    expect(res.status).toBe(403);
  });

  it('refuses a change with a wrong token', async () => {
    const lab = await testLab();
    const res = await lab.agent.post('/cases/master-delegation-001/archive').type('form').send({ _csrf: 'x'.repeat(CSRF.length) });
    expect(res.status).toBe(403);
  });

  it.each([
    { header: 'Origin', value: 'https://evil.example' },
    { header: 'Origin', value: 'null' },
    { header: 'Sec-Fetch-Site', value: 'cross-site' },
  ])('refuses a change whose $header is $value, even with the token', async ({ header, value }) => {
    const lab = await testLab();
    const res = await post(lab, '/cases/master-delegation-001/archive').set(header, value);
    expect(res.status).toBe(403);
  });

  it('accepts a same-origin change with the token', async () => {
    const lab = await testLab();
    const res = await post(lab, '/cases/master-delegation-001/archive').set('Origin', 'http://localhost:4317').set('Sec-Fetch-Site', 'same-origin');
    expect(res.status).toBe(303);
  });

  it('will not redirect anywhere outside the lab after changing the theme', async () => {
    const lab = await testLab(false);
    const res = await post(lab, '/theme', { theme: 'light', back: '//evil.example/x' });
    expect(res.headers['location']).toBe('/');
  });
});

describe('stored text cannot inject markup or script', () => {
  it('escapes HTML in every interpolated value', () => {
    expect(html`<p>${'<script>alert(1)</script>'}</p>`.value).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(escapeHtml(`" onmouseover='x'`)).toBe('&quot; onmouseover=&#39;x&#39;');
  });

  it('shows an imported case title with a script tag as plain text', async () => {
    const lab = await testLab();
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const file = {
      schema: 'eval-lab/evaluation-case',
      schemaVersion: 1,
      id: 'case-xss',
      version: 1,
      status: 'frozen',
      specialistId: 'master',
      title: evil,
      task: evil,
      provenance: { origin: 'user', source: 'file-import' },
      privacy: 'local-private',
      createdAt: '2026-10-01T00:00:00Z',
    };
    await lab.agent.post('/cases/import').field('_csrf', CSRF).attach('file', Buffer.from(JSON.stringify(file)), 'evil.json');
    const page = await lab.agent.get('/cases/case-xss/v/1');
    expect(page.status).toBe(200);
    expect(page.text).not.toContain('<script>alert(2)');
    expect(page.text).not.toContain('<img src=x');
    expect(page.text).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(page.text).toContain('Candidate');
  });
});

describe('file handling', () => {
  it.each(['../../etc/passwd', '..', 'a/b', 'case id', '', 'x'.repeat(101)])('refuses the unsafe id %j', (id) => {
    expect(Id.safeParse(id).success).toBe(false);
  });

  it.each([
    ['local', '../records/cases.json'],
    ['local', '..%2Fsecret.png'],
    ['fixture', '../../package.json'],
    ['other', 'outfit-before.png'],
    ['fixture', 'outfit-before.svg'],
    ['fixture', 'missing.png'],
  ])('refuses the attachment path %s/%s', async (store, name) => {
    const s = await freshStore(false);
    expect(attachmentPath(store, name, s.attachmentsDir)).toBeNull();
  });

  it('serves a real fixture image with its media type and refuses traversal over HTTP', async () => {
    const lab = await testLab(false);
    const ok = await lab.agent.get('/attachments/fixture/outfit-before.png');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect((await lab.agent.get('/attachments/fixture/..%2F..%2Fpackage.json')).status).toBe(404);
    expect((await lab.agent.get('/attachments/local/..%2Frecords%2Fcases.json')).status).toBe(404);
  });

  it('accepts images by their contents only', () => {
    expect(detectImageType(PNG_BYTES)).toBe('png');
    expect(detectImageType(SVG_AS_PNG)).toBeNull();
    expect(detectImageType(Buffer.from('GIF89a'))).toBeNull();
  });

  it('refuses an SVG renamed to .png when uploaded as evidence', async () => {
    const lab = await testLab();
    const res = await lab.agent
      .post('/evaluate/master-delegation-001/v/1/outputs')
      .field('_csrf', CSRF)
      .field('label', 'With an image')
      .field('toolName', 'Image generator')
      .attach('toolImage', SVG_AS_PNG, { filename: 'innocent.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Only PNG, JPEG and WebP images are accepted');
  });

  it('refuses an image over 5 MB', async () => {
    const lab = await testLab();
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);
    const res = await lab.agent.post('/evaluate/master-delegation-001/v/1/outputs').field('_csrf', CSRF).field('label', 'Big').attach('toolImage', big, 'big.png');
    expect(res.status).toBe(413);
  });

  it('treats a JSON file that is not valid JSON as a clear error', async () => {
    const lab = await testLab();
    const res = await lab.agent.post('/imports/assessments').field('_csrf', CSRF).attach('file', Buffer.from('{not json'), 'broken.json');
    expect(res.status).toBe(400);
    expect(res.text).toContain('not valid JSON');
  });
});

describe('logs and local data', () => {
  it('logs the method, path and status only — never form contents or query strings', async () => {
    const store = await freshStore();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const agent = request(createApp({ store, csrf: CSRF, log: true }));
    await agent.post('/observations').type('form').send({ _csrf: CSRF, type: 'failure', source: 'chat', whatHappened: 'PRIVATE-DETAIL-123' });
    await agent.get('/cases?q=PRIVATE-QUERY-456');
    const lines = log.mock.calls.map((c) => c.join(' ')).join('\n');
    log.mockRestore();
    expect(lines).toContain('POST /observations 303');
    expect(lines).not.toContain('PRIVATE-DETAIL-123');
    expect(lines).not.toContain('PRIVATE-QUERY-456');
  });

  it('keeps the default data folder out of Git', () => {
    expect(relative(APP_ROOT, DEFAULT_DATA_DIR)).toBe('data');
    const ignored = execFileSync('git', ['check-ignore', 'data/records/cases.json', 'data/attachments/x.png'], { cwd: APP_ROOT, encoding: 'utf8' });
    expect(ignored.trim().split('\n')).toHaveLength(2);
  });
});

describe('the lab never runs imported content or reaches the network', () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sourceFiles(path) : [path];
    });
  const FORBIDDEN = ['eval(', 'new Function(', "from 'node:child_process'", "from 'child_process'", "from 'node:http'", "from 'node:https'", 'fetch(', "from 'node:vm'"];

  it.each(FORBIDDEN)('application source never uses %s', (needle) => {
    const offenders = sourceFiles(join(APP_ROOT, 'src')).filter((f) => readFileSync(f, 'utf8').includes(needle));
    expect(offenders).toEqual([]);
  });
});
