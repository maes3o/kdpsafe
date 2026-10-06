'use strict';

/**
 * Page-geometry V2: regression tests for two reproduced FALSE-READY
 * defects plus the page-size-vs-trim-size contract.
 *
 *  1. With bleed=false, an object extending PAST the trim edge used to be
 *     skipped (classifyViolations: "can't evaluate bleed coverage"), while
 *     the same object stopping AT the edge was a LEM violation.
 *  2. /Rotate was diagnostic-only, so a page displayed at 9x6in could pass
 *     as a 6x9 READY page.
 *  3. document.trimWidthIn/trimHeightIn were really the MediaBox size; the
 *     result now exposes pageWidthIn/pageHeightIn (effective, rotation- and
 *     CropBox-aware) and no longer calls it "trim".
 */

const assert = require('node:assert/strict');
const {
  PDFDocument,
  StandardFonts,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  setFillingRgbColor,
  fill,
} = require('pdf-lib');
const { runPreflight } = require('../lib/orchestrator');
const { inspectManuscript } = require('../lib/manuscript');

const rect = (x, y, w, h) => [pushGraphicsState(), setFillingRgbColor(0.2, 0.2, 0.2), rectangle(x, y, w, h), fill(), popGraphicsState()];
const U = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false };

async function build({ w, h, trim, rects = [], text, rotate, rotatePage = 0, pages = 30, crop }) {
  const doc = await PDFDocument.create();
  const font = text ? await doc.embedFont(StandardFonts.Helvetica) : null;
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([w, h]);
    if (trim) p.setTrimBox(...trim);
    if (crop) p.setCropBox(...crop);
    if (i === rotatePage && rotate) p.setRotation(degrees(rotate));
    if (i === 0) {
      for (const r of rects) p.pushOperators(...rect(...r));
      if (text) p.drawText(text.str, { x: text.x, y: text.y, size: text.size ?? 12, font });
    }
  }
  return doc.save();
}

let n = 0;
async function runCase(label, fn) {
  n += 1;
  await fn();
  console.log(`  [${n}] ${label}: OK`);
}

const notReady = (r, msg) => assert.notEqual(r.verdict, 'READY', msg);

async function main() {
  // ---------- 1. content past the trim edge, bleed=false ----------
  await runCase('control: an object well inside the safe zone is still READY (no blanket false positives)', async () => {
    const r = await runPreflight(await build({ w: 432, h: 648, trim: [0, 0, 432, 648], rects: [[100, 200, 100, 100]] }), { userIntent: U });
    assert.equal(r.verdict, 'READY');
  });

  await runCase('I. page == trim: object crossing the LEFT page edge is never READY', async () => {
    const r = await runPreflight(await build({ w: 432, h: 648, trim: [0, 0, 432, 648], rects: [[-20, 200, 120, 100]] }), { userIntent: U });
    notReady(r);
    assert.ok(r.violations.some((v) => v.side === 'left'));
    assert.ok(r.categories.margins.manualReview.length > 0, 'over-threshold crossing needs manual review, not autofix');
    assert.equal(r.autofixPlans.length, 0);
  });

  await runCase('I. A4 page + explicit centred TrimBox: object crossing the trim edge is never READY', async () => {
    const r = await runPreflight(
      await build({ w: 595.28, h: 841.89, trim: [81.64, 96.945, 432, 648], rects: [[50, 300, 200, 100]] }),
      { userIntent: U }
    );
    notReady(r);
    assert.ok(r.violations.some((v) => v.side === 'left' && v.amountPt > 36), 'amount is measured to the safe zone');
  });

  await runCase('I. all four sides: crossing top/bottom/right is flagged too', async () => {
    const trim = [0, 0, 432, 648];
    const cases = { right: [400, 200, 100, 100], top: [100, 600, 100, 100], bottom: [100, -30, 100, 60] };
    for (const [side, r] of Object.entries(cases)) {
      const res = await runPreflight(await build({ w: 432, h: 648, trim, rects: [r] }), { userIntent: U });
      notReady(res, side);
      assert.ok(res.violations.some((v) => v.side === side), side);
    }
  });

  await runCase('I. TEXT crossing the trim edge is a text violation, never READY', async () => {
    const r = await runPreflight(
      await build({ w: 432, h: 648, trim: [0, 0, 432, 648], text: { str: 'This line runs off the right edge of the page', x: 300, y: 300, size: 14 } }),
      { userIntent: U }
    );
    notReady(r);
    assert.ok(r.categories.margins.manualReview.some((m) => m.reason === 'TEXT_LEM_VIOLATION'));
  });

  await runCase('I. marks/slug outside TrimBox with bleed=false are surfaced, not silently ignored', async () => {
    const r = await runPreflight(
      await build({ w: 595.28, h: 841.89, trim: [81.64, 96.945, 432, 648], rects: [[200, 300, 100, 100], [40, 420, 30, 1]] }),
      { userIntent: U }
    );
    notReady(r);
  });

  await runCase('bleed=true behaviour is unchanged: art that reaches/exceeds the bleed edge stays safe', async () => {
    const trim = [0, 9, 432, 648];
    const bleed = [0, 0, 441, 666];
    const bytes = await (async () => {
      const doc = await PDFDocument.create();
      for (let i = 0; i < 30; i++) {
        const p = doc.addPage([441, 666]);
        p.setTrimBox(...trim);
        p.setBleedBox(...bleed);
        if (i === 0) p.pushOperators(...rect(0, 0, 441, 100)); // full-bleed strip along the bottom
      }
      return doc.save();
    })();
    const r = await runPreflight(bytes, { userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true, readingDirection: 'ltr' } });
    assert.ok(!r.violations.some((v) => v.violation === 'BLEED' && v.side === 'bottom'), 'bleed-covering art is intentional');
  });

  // ---------- 2. rotation ----------
  await runCase('H. /Rotate 0: normal evaluation (READY)', async () => {
    const r = await runPreflight(await build({ w: 432, h: 648, trim: [0, 0, 432, 648], rects: [[100, 200, 100, 100]], rotate: 0 }), { userIntent: U });
    assert.equal(r.verdict, 'READY');
  });

  for (const deg of [90, 180, 270]) {
    await runCase(`H. /Rotate ${deg} on one page: document is never READY, reason is explicit`, async () => {
      const r = await runPreflight(
        await build({ w: 432, h: 648, trim: [0, 0, 432, 648], rects: [[100, 200, 100, 100]], rotate: deg, rotatePage: 0 }),
        { userIntent: U }
      );
      notReady(r);
      assert.equal(r.verdict, 'MANUAL_REVIEW_REQUIRED');
      const entry = r.categories.margins.manualReview.find((m) => m.reason === 'PAGE_ROTATION_UNSUPPORTED');
      assert.ok(entry, 'PAGE_ROTATION_UNSUPPORTED reported');
      assert.equal(entry.pageIndex, 0);
      assert.equal(r.geometry.pages[0].status, 'unavailable');
      assert.equal(r.geometry.pages[1].status, 'partial', 'unrotated pages are unaffected');
    });
  }

  await runCase('H. the original reproduction: 432x648 + /Rotate 90 + TrimBox 6x9 was READY, must not be', async () => {
    const r = await runPreflight(await build({ w: 432, h: 648, trim: [0, 0, 432, 648], rotate: 90, pages: 30 }), { userIntent: U });
    notReady(r);
  });

  // ---------- 3. page size vs trim size ----------
  await runCase('document.* exposes PAGE size (no trimWidthIn): CropBox + rotation aware', async () => {
    const plain = await runPreflight(await build({ w: 595.28, h: 841.89 }), { userIntent: U });
    assert.ok(Math.abs(plain.document.pageWidthIn - 8.2678) < 0.001);
    assert.ok(Math.abs(plain.document.pageHeightIn - 11.6929) < 0.001);
    assert.equal('trimWidthIn' in plain.document, false);
    assert.equal('trimHeightIn' in plain.document, false);

    const rotated = await inspectManuscript(await build({ w: 432, h: 648, rotate: 90, rotatePage: 0 }));
    assert.equal(rotated.pageWidthIn, 9, '/Rotate 90 displays 9x6in');
    assert.equal(rotated.pageHeightIn, 6);
    assert.equal(rotated.pageSizeConsistent, false, 'rotated page differs from its siblings');

    const cropped = await inspectManuscript(await build({ w: 612, h: 792, crop: [90, 72, 432, 648] }));
    assert.equal(cropped.pageWidthIn, 6, 'visible (CropBox) size, not MediaBox 8.5x11');
    assert.equal(cropped.pageHeightIn, 9);
    // deprecated aliases exist only for the cover pipeline
    assert.equal(cropped.trimWidthIn, cropped.pageWidthIn);
  });

  console.log(`\nfalse-ready.test.js: ${n} cases passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
