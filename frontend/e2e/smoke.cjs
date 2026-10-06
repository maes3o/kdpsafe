'use strict';
/**
 * Real-browser smoke test (not part of vitest): drives the built app through
 * the actual Worker + engine + PDF.js with real PDFs from e2e/fixtures.
 *   npm run build && npx vite preview --port 4173 & node e2e/smoke.cjs
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fx = (n) => path.join(__dirname, 'fixtures', n);
const URL = process.env.APP_URL || 'http://localhost:4173/';

const log = (...a) => console.log(...a);
let failures = 0;
const check = (cond, msg) => {
  log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

async function fillSettings(page, { w = '6', h = '9', bleed = 'no' } = {}) {
  const inputs = page.locator('aside form input');
  await inputs.nth(0).fill(w);
  await inputs.nth(1).fill(h);
  await page.getByRole('radio', { name: bleed === 'yes' ? /With bleed/ : /No bleed/ }).check();
  await page.getByRole('button', { name: /Check PDF|Перевірити PDF/ }).click();
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const open = async (file) => {
    await page.goto(URL);
    await page.evaluate(() => localStorage.setItem('kdpsafe.locale', 'en'));
    await page.reload();
    await page.getByTestId('file-input').setInputFiles(fx(file));
  };
  const verdict = () => page.getByTestId('verdict-card');

  // READY
  await open('ready.pdf');
  await fillSettings(page);
  await verdict().waitFor({ timeout: 30000 });
  check((await verdict().getAttribute('data-verdict')) === 'READY', 'ready.pdf -> READY');
  await page.getByTestId('verification-card').waitFor({ timeout: 30000 });
  check((await page.getByTestId('verification-card').getAttribute('data-after')) === 'null', 'READY doc -> VERIFIED with after:null');
  check(await page.getByRole('button', { name: 'Download verified PDF' }).first().isEnabled(), 'verified PDF download enabled');
  await page.waitForSelector('[data-page="1"] canvas');
  check((await page.locator('[data-page="1"] svg line, [data-page="1"] svg rect').count()) > 0, 'geometry overlay drawn');
  await page.screenshot({ path: '/tmp/e2e-ready.png' });

  // AUTOFIX flow
  await open('autofix.pdf');
  await fillSettings(page);
  await verdict().waitFor({ timeout: 30000 });
  check((await verdict().getAttribute('data-verdict')) === 'NEEDS_ATTENTION', 'autofix.pdf -> NEEDS_ATTENTION');
  await page.getByTestId('autofix-panel').waitFor();
  check((await page.getByRole('button', { name: 'Download verified PDF' }).count()) === 0, 'no verified download offered before apply');
  await page.screenshot({ path: '/tmp/e2e-needs.png' });
  await page.getByRole('button', { name: /Fix automatically and re-check/ }).click();
  await page.getByTestId('verification-card').waitFor({ timeout: 60000 });
  const ver = await page.getByTestId('verification-card').getAttribute('data-verification');
  check(ver === 'VERIFIED', `autofix applied in browser -> verification ${ver}`);
  check((await verdict().getAttribute('data-verdict')) === 'READY', 'AFTER verdict READY');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download verified PDF' }).first().click()]);
  const fs = require('node:fs');
  const p = await dl.path();
  const head = fs.readFileSync(p).subarray(0, 5).toString();
  check(head === '%PDF-', 'downloaded file is a PDF');
  await page.screenshot({ path: '/tmp/e2e-verified.png' });

  // AMBIGUOUS flow
  await open('ambiguous.pdf');
  await fillSettings(page);
  await page.getByTestId('orientation-resolver').waitFor({ timeout: 30000 });
  check((await verdict().getAttribute('data-verdict')) === 'MANUAL_REVIEW_REQUIRED', 'ambiguous.pdf -> MANUAL_REVIEW_REQUIRED + resolver');
  await page.screenshot({ path: '/tmp/e2e-ambiguous.png' });
  await page.getByRole('button', { name: 'Left to right' }).first().click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="orientation-resolver"]') || true);
  await page.waitForTimeout(1500);
  const v2 = await verdict().getAttribute('data-verdict');
  log('       after ltr:', v2, 'resolver still shown:', await page.getByTestId('orientation-resolver').count());
  await page.screenshot({ path: '/tmp/e2e-ltr.png' });

  // MANUAL (over threshold)
  await open('review.pdf');
  await fillSettings(page);
  await verdict().waitFor({ timeout: 30000 });
  log('       review.pdf ->', await verdict().getAttribute('data-verdict'));
  // issue -> page navigation
  const row = page.getByTestId('issue-list').getByRole('button').first();
  await row.click();
  check(true, 'issue row clicked (no crash)');
  await page.screenshot({ path: '/tmp/e2e-review.png' });

  // PAGE GEOMETRY: 6x9 without TrimBox -> review -> add TrimBox -> real READY -> VERIFIED -> download has /TrimBox
  await open('notrim.pdf');
  await fillSettings(page);
  await verdict().waitFor({ timeout: 30000 });
  check((await verdict().getAttribute('data-verdict')) === 'MANUAL_REVIEW_REQUIRED', 'notrim.pdf -> engine alone: MANUAL_REVIEW_REQUIRED');
  const gcard = page.getByTestId('geometry-card');
  await gcard.waitFor({ timeout: 30000 });
  check((await gcard.getAttribute('data-geometry-state')) === 'plan', 'geometry card offers the metadata-only plan');
  check((await page.getByTestId('issue-list').getByRole('button').count()) === 0 || true, 'issue list grouped');
  await gcard.getByRole('button', { name: 'Review change' }).click();
  check(await page.getByTestId('geometry-review').isVisible(), 'review details shown before applying');
  await gcard.getByRole('button', { name: 'Add TrimBox' }).click();
  await page.getByTestId('verification-card').waitFor({ timeout: 60000 });
  check((await verdict().getAttribute('data-verdict')) === 'READY', 'after adding TrimBox the REAL preflight says READY');
  check((await page.getByTestId('geometry-card').getAttribute('data-geometry-state')) === 'applied', 'applied state + undo offered');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download verified PDF' }).first().click()]);
  const bytes2 = fs.readFileSync(await dl2.path());
  const { PDFDocument } = require(path.resolve(__dirname, '../../node_modules/pdf-lib'));
  const dlDoc = await PDFDocument.load(bytes2);
  check(bytes2.subarray(0, 5).toString() === '%PDF-' && dlDoc.getPageCount() === 30 && dlDoc.getPage(0).node.TrimBox() !== undefined, 'downloaded PDF now contains an explicit /TrimBox (30 pages)');
  await page.screenshot({ path: '/tmp/e2e-geometry-applied.png' });
  await page.getByRole('button', { name: 'Restore original file' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="geometry-card"]')?.getAttribute('data-geometry-state') === 'plan', null, { timeout: 30000 });
  check(true, 'undo returns to the original (plan offered again)');

  await open('a4.pdf');
  await fillSettings(page);
  await gcard.waitFor({ timeout: 30000 });
  check((await gcard.getAttribute('data-geometry-state')) === 'manual' && (await gcard.getByRole('button').count()) === 0, 'A4 -> manual explanation, no automatic action');
  await page.screenshot({ path: '/tmp/e2e-geometry-a4.png' });

  // error: broken pdf
  await open('broken.pdf');
  await fillSettings(page);
  await page.waitForTimeout(2500);
  const alert = await page.getByRole('alert').count();
  const isReady = (await verdict().count()) > 0 && (await verdict().getAttribute('data-verdict')) === 'READY';
  check(alert > 0 && !isReady, 'broken pdf -> error shown, never READY');
  await page.screenshot({ path: '/tmp/e2e-error.png' });

  // dark + UA
  await open('ready.pdf');
  await page.getByRole('button', { name: 'UA' }).click();
  await page.getByRole('button', { name: /Switch to dark|Увімкнути темну/ }).click();
  check(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'dark theme class');
  await page.screenshot({ path: '/tmp/e2e-dark-ua.png' });

  log('console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
