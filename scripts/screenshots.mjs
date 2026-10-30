// Takes a screenshot of every page in the dark and light themes, for the pull request.
// Needs Playwright (not an app dependency): run with a lab already started on the given address,
// for example `node scripts/screenshots.mjs http://localhost:4317 docs/screenshots`.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Loaded with require so a globally installed Playwright is found too.
const { chromium } = createRequire(import.meta.url)('playwright');

const [base = 'http://localhost:4317', outDir = 'docs/screenshots'] = process.argv.slice(2);
const PAGES = [
  ['01-overview', '/'],
  ['02-library', '/cases'],
  ['03-case-detail', '/cases/master-stale-status-003/v/1'],
  ['04-case-candidate', '/cases/master-vague-request-006/v/1'],
  ['05-profiles', '/profiles'],
  ['06-profile-lore', '/profiles/lore/v/1'],
  ['07-evaluate', '/evaluate'],
  ['08-evaluate-designer', '/evaluate/designer-outfit-mods-001/v/1'],
  ['09-score-form', '/outputs/out-master-delegation-001-a/score'],
  ['10-result', '/results/res-lore-prose-vs-canon-002-b'],
  ['11-spot-check-queue', '/review'],
  ['12-spot-check-item', '/review/FIRST_PENDING'],
  ['13-compare', '/compare'],
  ['14-blind-comparison', '/compare/FIRST_OPEN'],
  ['15-comparison-report', '/compare/report?case=master-queue-ordering-004&version=1'],
  ['16-history', '/history'],
  ['17-observations', '/observations'],
  ['18-settings-data', '/data'],
];

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const resolvePath = async (page, path) => {
  if (!path.includes('FIRST_')) return path;
  const list = path.startsWith('/review') ? '/review' : '/compare';
  await page.goto(base + list);
  const selector = list === '/review' ? 'a[href^="/review/"]:not([href*="batch"])' : 'a[href^="/compare/cmp"]';
  return (await page.locator(selector).first().getAttribute('href')) ?? list;
};
for (const theme of ['dark', 'light']) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await context.addCookies([{ name: 'theme', value: theme, url: base }]);
  const page = await context.newPage();
  for (const [name, path] of PAGES) {
    const target = await resolvePath(page, path);
    const response = await page.goto(base + target);
    if (!response || response.status() !== 200) throw new Error(`${target} returned ${response?.status()}`);
    await page.screenshot({ path: join(outDir, `${name}-${theme}.jpg`), fullPage: true, type: 'jpeg', quality: 72 });
  }
  await context.close();
}
await browser.close();
console.log(`Saved ${PAGES.length * 2} screenshots to ${outDir}`);
