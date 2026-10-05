'use strict';

/**
 * CHECKPOINT 5C (2026-10-05): Option D implementation tests --
 * (1) conservative orientation-independent margin geometry,
 * (2) exact orientation resolution via userIntent.readingDirection,
 * per the object-level contract approved in CHECKPOINT 5B and proven safe
 * in CHECKPOINT 5A.
 *
 * Complements (does not duplicate) the updated assertions already added
 * to test/zones-builder.test.js (cases 1, 27-33), test/zoneGeometry.test.js
 * (cases 8, 8b, 14, 19-21), and test/orchestrator.test.js (Part C1/C3/C3b)
 * for the lower-level unit contracts. This file exercises the remaining
 * items from the CHECKPOINT 5C test list end-to-end through
 * lib/orchestrator.js's real runPreflight() pipeline: exact-orientation
 * resolution (B), bleed behavior (C), autofix eligibility (D), and a
 * multi-page regression check (E) specific to conservative mode.
 */

const assert = require('node:assert/strict');
const {
  PDFDocument,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  setFillingRgbColor,
  fill,
} = require('pdf-lib');
const { runPreflight } = require('../lib/orchestrator');

function rectOps(x, y, w, h) {
  return [pushGraphicsState(), setFillingRgbColor(0.2, 0.2, 0.2), rectangle(x, y, w, h), fill(), popGraphicsState()];
}

async function makeFixturePdf({ widthIn, heightIn, pages, explicitTrimBox }) {
  const doc = await PDFDocument.create();
  for (const pageSpec of pages) {
    const page = doc.addPage([widthIn * 72, heightIn * 72]);
    if (explicitTrimBox) page.setTrimBox(...explicitTrimBox);
    for (const r of pageSpec.rects || []) {
      page.pushOperators(...rectOps(r.x, r.y, r.width, r.height));
    }
  }
  return doc.save();
}

let caseCount = 0;
async function runCase(label, fn) {
  caseCount += 1;
  await fn();
  console.log(`  [${caseCount}] ${label}: OK`);
}

async function main() {
  // =====================================================================
  // A. Conservative geometry -- object-level classification, end-to-end
  //    (A1 "safe under both" and A4 "violates both" are already covered
  //    end-to-end by orchestrator.test.js Part C3/C1; A2/A3 here.)
  // =====================================================================

  // A2/A3: an object safe under exactly one named hypothesis is AMBIGUOUS
  // in BOTH directions (mirrors orchestrator.test.js's C3b, which covers
  // "safe under RTL only" -- this covers "safe under LTR only").
  // insidePt=27pt, outsidePt=18pt (pageCount=100, 6x9in, no bleed):
  // conservative=[27,405], ltr=[27,414], rtl=[18,405]. An object at
  // x:[398,412] fails rtl (412>405) but passes ltr (398>=27, 412<=414).
  await runCase('A2. object safe under LTR only -> AMBIGUOUS, not violation', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 398, y: 300, width: 14, height: 20 }] }], // x:[398,412]
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
      pageContext: { pageCount: 100 },
    });
    assert.equal(result.violations.length, 0, 'A2: must never appear in violations[]');
    const ambiguous = result.categories.margins.manualReview.filter((e) => e.reason === 'LEM_ORIENTATION_AMBIGUOUS');
    assert.equal(ambiguous.length, 1, 'A2: exactly one ambiguous entry');
    assert.equal(ambiguous[0].sides[0], 'right');
    assert.deepEqual(ambiguous[0].orientation, { ltr: 'safe', rtl: 'violation' });
    assert.equal(result.verdict, 'MANUAL_REVIEW_REQUIRED');
  });

  // =====================================================================
  // B. Exact orientation resolution, end-to-end via userIntent.readingDirection
  // =====================================================================

  // Shared setup: 6x9in, no bleed, pageCount=100 -> insidePt=27pt,
  // outsidePt=18pt. A 2-page document so page index 0 is pageNumber=1
  // (odd) and page index 1 is pageNumber=2 (even). The SAME object
  // bbox (x:[20,40]) is placed on both pages: it fails the LEFT boundary
  // only when inside is on the LEFT (insidePt=27 > 20), and is safe when
  // inside is on the RIGHT (outsidePt=18 <= 20).
  async function buildTwoPageFixture() {
    return makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 20, y: 300, width: 20, height: 20 }] }, { rects: [{ x: 20, y: 300, width: 20, height: 20 }] }],
    });
  }

  await runCase('B5. LTR odd page (pageNumber=1) -> inside=left -> violation', async () => {
    const bytes = await buildTwoPageFixture();
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'ltr' },
      pageContext: { pageCount: 100 },
    });
    const page0 = result.geometry.pages[0];
    assert.equal(page0.status, 'complete', 'B5: exact orientation -> geometryStatus complete');
    const page0Violations = result.violations.filter((v) => v.pageIndex === 0);
    assert.equal(page0Violations.length, 1, 'B5: inside=left (insidePt=27) -> object at x:[20,40] violates (20<27)');
    assert.equal(page0Violations[0].side, 'left');
    const page0Ambiguous = result.categories.margins.manualReview.filter((e) => e.reason === 'LEM_ORIENTATION_AMBIGUOUS' && e.pageIndex === 0);
    assert.equal(page0Ambiguous.length, 0, 'B5: exact mode never produces an ambiguous entry');
  });

  await runCase('B6. LTR even page (pageNumber=2) -> inside=right -> safe', async () => {
    const bytes = await buildTwoPageFixture();
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'ltr' },
      pageContext: { pageCount: 100 },
    });
    const page1Violations = result.violations.filter((v) => v.pageIndex === 1);
    assert.equal(page1Violations.length, 0, 'B6: inside=right (outsidePt=18) -> object at x:[20,40] is safe (20>=18)');
  });

  await runCase('B7. RTL odd page (pageNumber=1) -> inverted -> inside=right -> safe', async () => {
    const bytes = await buildTwoPageFixture();
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'rtl' },
      pageContext: { pageCount: 100 },
    });
    const page0Violations = result.violations.filter((v) => v.pageIndex === 0);
    assert.equal(page0Violations.length, 0, 'B7: RTL inverts the odd-page rule -> inside=right -> safe at x:[20,40]');
  });

  await runCase('B8. RTL even page (pageNumber=2) -> inverted -> inside=left -> violation', async () => {
    const bytes = await buildTwoPageFixture();
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'rtl' },
      pageContext: { pageCount: 100 },
    });
    const page1Violations = result.violations.filter((v) => v.pageIndex === 1);
    assert.equal(page1Violations.length, 1, 'B8: RTL inverts the even-page rule -> inside=left -> violation at x:[20,40]');
    assert.equal(page1Violations[0].side, 'left');
  });

  // =====================================================================
  // C. Bleed
  // =====================================================================

  await runCase('C9. bleed=false conservative -- already covered end-to-end by orchestrator.test.js Part C1/C3/C3b', async () => {
    // Intentionally a no-op placeholder case so this file's numbering
    // matches CHECKPOINT 5C's test list 1:1; the real assertions live in
    // test/orchestrator.test.js to avoid duplicating the same fixtures.
    assert.ok(true);
  });

  await runCase('C10. bleed=true remains horizontal-unresolved without readingDirection', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 200, y: 300, width: 20, height: 20 }] }],
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true },
      pageContext: { pageCount: 100 },
    });
    assert.equal(result.geometry.pages[0].allowedSides.left, false, 'C10: left stays blocked -- bleed horizontal still unresolved');
    assert.equal(result.geometry.pages[0].allowedSides.right, false, 'C10: right stays blocked for the same reason');
    assert.ok(
      result.categories.margins.manualReview.some((e) => e.reason === 'HORIZONTAL_GEOMETRY_UNRESOLVED'),
      'C10: the existing HORIZONTAL_GEOMETRY_UNRESOLVED reason still fires for bleed=true without readingDirection'
    );
    assert.equal(result.verdict, 'MANUAL_REVIEW_REQUIRED');
  });

  await runCase('C11. bleed=true resolves horizontal bleed exactly with readingDirection -- detects a genuine BLEED violation', async () => {
    // pageCount=700 (501-700 row -> insidePt=0.75in=54pt), bleed=true
    // (outsidePt=0.375in=27pt). LTR, odd page -> inside=left.
    // safeZone=[54,405]; bleedBox=[0,441] (inside edge +0, outside edge
    // +0.125in=9pt). Object x:[425,440] crosses trim (432) on the right
    // but falls 1pt short of the bleed edge (441).
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 425, y: 300, width: 15, height: 20 }] }], // x:[425,440]
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true, readingDirection: 'ltr' },
      pageContext: { pageCount: 700 },
    });
    assert.equal(result.geometry.pages[0].status, 'complete', 'C11: trim+bleed+margin all exactly resolved');
    assert.equal(result.geometry.pages[0].allowedSides.right, true);
    const bleedViolations = result.violations.filter((v) => v.violation === 'BLEED');
    assert.equal(bleedViolations.length, 1, 'C11: a real, exactly-resolved BLEED violation is detected');
    assert.equal(bleedViolations[0].side, 'right');
    assert.equal(Math.round(bleedViolations[0].amountPt), 1);
  });

  // =====================================================================
  // D. Autofix
  // =====================================================================

  await runCase('D12. ambiguous object never gets an autofix plan', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 20, y: 300, width: 20, height: 20 }] }], // x:[20,40] -- ambiguous under conservative (see A2)
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
      pageContext: { pageCount: 100 },
    });
    assert.ok(
      result.categories.margins.manualReview.some((e) => e.reason === 'LEM_ORIENTATION_AMBIGUOUS'),
      'D12 precondition: the object is indeed classified ambiguous'
    );
    assert.equal(result.autofixPlans.length, 0, 'D12: no autofix plan exists for an ambiguous object');
  });

  await runCase('D13. a definite (non-ambiguous) violation gets autofix once conservative geometry is fully resolved', async () => {
    // Top/bottom are never orientation-dependent, so a small top-margin
    // overshoot is exactly the kind of "definite violation with a
    // resolved safe target" case -- and, because bleed=false now fully
    // resolves all four sides (CHECKPOINT 5C), this is the FIRST
    // real-pipeline scenario where runPreflight() can produce a genuine,
    // non-fixture-only autofix plan end-to-end.
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 200, y: 200, width: 20, height: 434 }] }], // maxY=634, safeZone.maxY=630 -> 4pt overshoot
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
      pageContext: { pageCount: 100 },
    });
    assert.equal(result.autofixPlans.length, 1, 'D13: exactly one autofix plan');
    assert.equal(Math.round(result.autofixPlans[0].shift.dy), -4);
    assert.equal(result.autofixPlans[0].applyable, true);
  });

  await runCase('D14. exact-mode autofix targets the EXACT safe zone, not the conservative one', async () => {
    // LTR, odd page -> inside=left -> safeZone=[27,414] (maxX=432-18=414).
    // The CONSERVATIVE maxX would instead be 432-27=405 -- different.
    // Object x:[408,420] overshoots the EXACT boundary (414) by 6pt.
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 408, y: 300, width: 12, height: 20 }] }], // x:[408,420]
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'ltr' },
      pageContext: { pageCount: 100 },
    });
    assert.equal(result.geometry.pages[0].safeZone.maxX, 414, 'D14 precondition: exact safe zone maxX is 414, not the conservative 405');
    assert.equal(result.autofixPlans.length, 1, 'D14: one autofix plan');
    assert.equal(result.autofixPlans[0].fixedBBoxPt.maxX, 414, 'D14: the plan targets the EXACT boundary (414), confirming it is not silently using the conservative one (405)');
  });

  // =====================================================================
  // E. Regression
  // =====================================================================

  await runCase('E18b. multi-page PDF under conservative mode does not regress the pdfjs buffer-detachment fix', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [
        { rects: [{ x: 200, y: 200, width: 20, height: 20 }] },
        { rects: [{ x: 200, y: 200, width: 20, height: 20 }] },
        { rects: [{ x: 200, y: 200, width: 20, height: 20 }] },
      ],
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
      pageContext: { pageCount: 100 },
    });
    assert.equal(result.geometry.pages.length, 3, 'E18b: all three pages were actually processed, not just the first');
    assert.equal(result.verdict, 'READY', 'E18b: every page is safe-under-both-orientations -> READY (same object placement as C3)');
  });

  console.log(`\nAll ${caseCount} checkpoint5c.test.js cases passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
