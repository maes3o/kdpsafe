'use strict';

/**
 * CHECKPOINT 5D (2026-10-05): fixes for the findings from the read-only
 * CHECKPOINT 5D engine audit, and the new end-to-end autofix+verification
 * coverage that audit's section 7/finding list called for. Covers exactly
 * the approved scope -- nothing about SAFE/AMBIGUOUS/DEFINITE semantics,
 * KDP constants, Phase 2, or the frontend contract is touched here or in
 * the lib/ changes this file exercises.
 *
 * Sections:
 *   A. Finding #1 fix -- an autofix plan may never move an axis that only
 *      has an AMBIGUOUS entry on it (lib/orchestrator.js's new
 *      lockAmbiguousAxes()). Both the named case (LEFT ambiguous + TOP
 *      definite -> dx=0) and its mirror (RIGHT ambiguous + BOTTOM
 *      definite -> dx=0).
 *   B. Finding #2 fix -- geometry.horizontalResolution can never be
 *      'exact'/'conservative' when safeZoneBBoxPt (and therefore
 *      trimBoxPt) never actually resolved.
 *   C. Finding #4 -- real end-to-end applyAutofix -> re-runPreflight ->
 *      verification coverage for the conservative, exact, and mixed
 *      ambiguous+definite geometry states, none of which existed before
 *      this checkpoint (test/autofix-pipeline.test.js's own Part C never
 *      reaches a resolved page at all -- see that file's updated header).
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
const { runPreflight, verifyAutofix } = require('../lib/orchestrator');
const { buildZones } = require('../lib/zones');
const { buildZoneGeometry } = require('../lib/zoneGeometry');

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
  // A. Finding #1 fix: lockAmbiguousAxes() -- ambiguous-only axis is
  //    never moved by an autofix plan triggered by a DIFFERENT axis's
  //    DEFINITE violation.
  // =====================================================================

  // A1 (named case): x:[20,40] is LEFT-ambiguous under conservative mode
  // (pageCount=100, bleed=false -> insidePt=27pt, outsidePt=18pt;
  // conservative=[27,405], ltr=[27,414], rtl=[18,405] -- 20 is safe under
  // rtl (>=18) but violates ltr (<27) -> ambiguous). The SAME object also
  // has a small (4pt), autofix-eligible TOP overshoot (maxY=634 vs
  // safeZone.maxY=630). Before the fix, planAutofix's computeShiftToFit()
  // would have measured dx against the full conservative zone (27-20=7pt)
  // as a side effect of fixing the top -- silently moving an axis that
  // was never a confirmed violation. After the fix: dx MUST be exactly 0.
  await runCase('A1. LEFT ambiguous + TOP definite -> autofix plan has dx=0, only dy moves', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 20, y: 200, width: 20, height: 434 }] }], // bbox [20,200]-[40,634]
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
      pageContext: { pageCount: 100 },
    });

    const ambiguous = result.categories.margins.manualReview.filter((e) => e.reason === 'LEM_ORIENTATION_AMBIGUOUS');
    assert.equal(ambiguous.length, 1, 'A1 precondition: LEFT is ambiguous');
    assert.equal(ambiguous[0].sides[0], 'left');

    const topViolations = result.violations.filter((v) => v.side === 'top');
    assert.equal(topViolations.length, 1, 'A1 precondition: a genuine, definite TOP violation exists');
    assert.equal(result.violations.some((v) => v.side === 'left' || v.side === 'right'), false, 'A1 precondition: no LEFT/RIGHT entry in violations[] (it is ambiguous, not definite)');

    assert.equal(result.autofixPlans.length, 1, 'A1: exactly one autofix plan (for the definite top violation)');
    const plan = result.autofixPlans[0];
    assert.equal(plan.shift.dx, 0, 'A1 (THE FIX): dx must be exactly 0 -- the ambiguous LEFT axis is never moved');
    assert.equal(Math.round(plan.shift.dy), -4, 'A1: dy still correctly fixes the definite top overshoot');
    assert.equal(plan.fixedBBoxPt.minX, 20, 'A1: horizontal edges are completely unchanged by the plan');
    assert.equal(plan.fixedBBoxPt.maxX, 40);
    assert.equal(plan.fixedBBoxPt.maxY, 630);
  });

  // A2 (mirror case): x:[398,412] is RIGHT-ambiguous (safe under ltr<=414,
  // violates rtl's 405) with a small (4pt) BOTTOM overshoot (minY=14 vs
  // safeZone.minY=18). dx must again be exactly 0.
  await runCase('A2 (mirror). RIGHT ambiguous + BOTTOM definite -> autofix plan has dx=0, only dy moves', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 398, y: 14, width: 14, height: 20 }] }], // bbox [398,14]-[412,34]
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
      pageContext: { pageCount: 100 },
    });

    const ambiguous = result.categories.margins.manualReview.filter((e) => e.reason === 'LEM_ORIENTATION_AMBIGUOUS');
    assert.equal(ambiguous.length, 1, 'A2 precondition: RIGHT is ambiguous');
    assert.equal(ambiguous[0].sides[0], 'right');

    const bottomViolations = result.violations.filter((v) => v.side === 'bottom');
    assert.equal(bottomViolations.length, 1, 'A2 precondition: a genuine, definite BOTTOM violation exists');

    assert.equal(result.autofixPlans.length, 1, 'A2: exactly one autofix plan (for the definite bottom violation)');
    const plan = result.autofixPlans[0];
    assert.equal(plan.shift.dx, 0, 'A2 (THE FIX, mirrored): dx must be exactly 0 -- the ambiguous RIGHT axis is never moved');
    assert.equal(Math.round(plan.shift.dy), 4, 'A2: dy still correctly fixes the definite bottom overshoot');
    assert.equal(plan.fixedBBoxPt.minX, 398, 'A2: horizontal edges are completely unchanged by the plan');
    assert.equal(plan.fixedBBoxPt.maxX, 412);
    assert.equal(plan.fixedBBoxPt.minY, 18);
  });

  // A3 (regression): a PURE definite violation (no ambiguous entry at
  // all for this object) must be completely unaffected by the fix --
  // lockAmbiguousAxes() must be a no-op here, exactly reproducing the
  // pre-5D shift.
  await runCase('A3 (regression). pure definite TOP violation, no ambiguity -> unaffected by the axis lock', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 200, y: 200, width: 20, height: 434 }] }], // x comfortably inside [27,405]
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
      pageContext: { pageCount: 100 },
    });
    assert.equal(result.categories.margins.manualReview.filter((e) => e.reason === 'LEM_ORIENTATION_AMBIGUOUS').length, 0);
    assert.equal(result.autofixPlans.length, 1);
    assert.equal(Math.round(result.autofixPlans[0].shift.dy), -4);
    assert.equal(result.autofixPlans[0].shift.dx, 0, 'A3: dx is 0 here too, but because there was never any horizontal overshoot to begin with, not because of the lock');
  });

  // =====================================================================
  // B. Finding #2 fix: geometry.horizontalResolution can only be
  //    'exact'/'conservative' when safeZoneBBoxPt genuinely resolved.
  // =====================================================================

  await runCase('B1. no explicit /TrimBox + conservative-eligible margins -> geometry.horizontalResolution stays "unresolved", not "conservative"', () => {
    const sz = buildZones({ pageCount: 100 }, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
    assert.equal(sz.horizontalResolution, 'conservative', 'B1 precondition: the SEMANTIC layer (zones.js) does claim conservative');
    const geo = buildZoneGeometry(sz, {}); // no pdfBoxes.trimBox at all
    assert.equal(geo.trimBoxPt, null);
    assert.equal(geo.safeZoneBBoxPt, null);
    assert.equal(geo.horizontalResolution, 'unresolved', 'B1 (THE FIX): must not echo the semantic claim when no real geometry was ever built');
  });

  await runCase('B2. no explicit /TrimBox + exact readingDirection+pageNumber -> geometry.horizontalResolution stays "unresolved", not "exact"', () => {
    const sz = buildZones(
      { pageCount: 100, pageNumber: 1 },
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'ltr' }
    );
    assert.equal(sz.horizontalResolution, 'exact', 'B2 precondition: the SEMANTIC layer does claim exact');
    const geo = buildZoneGeometry(sz, {});
    assert.equal(geo.trimBoxPt, null);
    assert.equal(geo.safeZoneBBoxPt, null);
    assert.equal(geo.horizontalResolution, 'unresolved', 'B2 (THE FIX): must not echo the semantic claim when no real geometry was ever built');
  });

  await runCase('B3 (regression). WITH a real /TrimBox, conservative resolution still correctly reaches "conservative"', () => {
    const sz = buildZones({ pageCount: 100 }, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
    const geo = buildZoneGeometry(sz, { trimBox: { x: 0, y: 0, width: 6 * 72, height: 9 * 72 } });
    assert.notEqual(geo.safeZoneBBoxPt, null);
    assert.equal(geo.horizontalResolution, 'conservative', 'B3: the fix must not break the genuine positive case');
  });

  await runCase('B4 (regression). WITH a real /TrimBox, exact resolution still correctly reaches "exact"', () => {
    const sz = buildZones(
      { pageCount: 100, pageNumber: 1 },
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'ltr' }
    );
    const geo = buildZoneGeometry(sz, { trimBox: { x: 0, y: 0, width: 6 * 72, height: 9 * 72 } });
    assert.notEqual(geo.safeZoneBBoxPt, null);
    assert.equal(geo.horizontalResolution, 'exact', 'B4: the fix must not break the genuine positive case');
  });

  // =====================================================================
  // C. Finding #4: real end-to-end applyAutofix -> re-runPreflight ->
  //    verification coverage, for all three geometry states.
  // =====================================================================

  await runCase('C1 (conservative). full verifyAutofix() cycle reaches VERIFIED + READY', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 200, y: 200, width: 20, height: 434 }] }], // small TOP-only overshoot, x comfortably safe
    });
    const opts = { userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }, pageContext: { pageCount: 100 } };

    const result = await verifyAutofix(bytes, opts);
    assert.equal(result.before.geometry.pages[0].status, 'partial', 'C1 precondition: conservative resolution reaches "partial" geometryStatus, not "complete"');
    assert.equal(result.before.autofixPlans.length, 1);
    assert.equal(result.applied.length, 1, 'C1: the plan was actually byte-applied');
    assert.equal(result.skipped.length, 0);
    assert.ok(result.after, 'C1: a real AFTER re-check PDF was generated');
    assert.equal(result.after.violations.length, 0, 'C1: the fixed PDF, re-detected from scratch, truly has no violations left');
    assert.equal(result.after.verdict, 'READY', 'C1: the AFTER re-check genuinely reaches READY');
    assert.equal(result.verification, 'VERIFIED', 'C1: conservative-mode autofix can now reach real, end-to-end VERIFIED');
    assert.deepEqual(result.reasons, []);
  });

  await runCase('C2 (exact). full verifyAutofix() cycle reaches VERIFIED + READY, using the EXACT safe zone', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 408, y: 300, width: 12, height: 20 }] }], // overshoots the EXACT right boundary (414) by 6pt
    });
    const opts = {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'ltr' },
      pageContext: { pageCount: 100 },
    };

    const result = await verifyAutofix(bytes, opts);
    assert.equal(result.before.geometry.pages[0].status, 'complete', 'C2 precondition: exact resolution reaches "complete" geometryStatus');
    assert.equal(result.before.autofixPlans.length, 1);
    assert.equal(result.before.autofixPlans[0].fixedBBoxPt.maxX, 414, 'C2 precondition: the plan targets the EXACT boundary (414), not the conservative one (405)');
    assert.equal(result.applied.length, 1);
    assert.equal(result.skipped.length, 0);
    assert.ok(result.after);
    assert.equal(result.after.violations.length, 0, 'C2: the fixed PDF has no violations left');
    assert.equal(result.after.verdict, 'READY');
    assert.equal(result.verification, 'VERIFIED', 'C2: exact-mode autofix reaches real, end-to-end VERIFIED');
  });

  await runCase('C3 (mixed ambiguous+definite). full verifyAutofix() cycle: TOP gets fixed, LEFT stays ambiguous -- documents a NOT-in-scope follow-on gap', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 20, y: 200, width: 20, height: 434 }] }], // same fixture as A1
    });
    const opts = { userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }, pageContext: { pageCount: 100 } };

    const result = await verifyAutofix(bytes, opts);
    assert.equal(result.before.autofixPlans.length, 1);
    assert.equal(result.before.autofixPlans[0].shift.dx, 0, 'C3: confirms the THE FIX end-to-end -- the plan that actually gets byte-applied never touches the ambiguous axis');
    assert.equal(result.applied.length, 1);
    assert.equal(result.skipped.length, 0);
    assert.ok(result.after);

    // The definite TOP problem is genuinely gone...
    assert.equal(result.after.violations.length, 0, 'C3: no definite violations remain -- the top overshoot was genuinely fixed');
    // ...but the object's x-position never moved (dx=0, by design), so it
    // is STILL exactly as LEFT-ambiguous as before the fix.
    const afterAmbiguous = result.after.categories.margins.manualReview.filter((e) => e.reason === 'LEM_ORIENTATION_AMBIGUOUS');
    assert.equal(afterAmbiguous.length, 1, 'C3: the LEFT ambiguity genuinely persists after the fix (dx=0 means its x-position is unchanged)');
    assert.equal(result.after.verdict, 'MANUAL_REVIEW_REQUIRED', 'C3: the document-level verdict correctly still reflects the surviving ambiguity');

    // KNOWN, NOT-FIXED-IN-THIS-CHECKPOINT GAP (discovered while writing
    // this exact test, explicitly left alone per this checkpoint's scope
    // -- "виправ лише перелічені 5D findings"): evaluateVerification()
    // only ever inspects `after.violations[]` and `after.geometry`, never
    // `after.categories.margins.manualReview[]` or `after.verdict`. Since
    // the surviving ambiguity lives in manualReview, not violations[],
    // verifyAutofix() reports VERIFIED here even though after.verdict is
    // still MANUAL_REVIEW_REQUIRED. This is a real contract inconsistency
    // (verification:'VERIFIED' coexisting with verdict !== 'READY') for a
    // FUTURE checkpoint to close -- documented, not silently left
        // unasserted, so a future change to evaluateVerification() that
    // fixes it will fail this exact assertion as an intentional prompt to
    // update this comment, not an accidental regression.
    assert.equal(result.verification, 'VERIFIED', 'C3 (documents the gap): verifyAutofix() does not yet account for a persisting manualReview/ambiguous entry -- see comment above');
  });

  console.log(`\nAll ${caseCount} checkpoint5d.test.js cases passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
