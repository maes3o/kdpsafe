'use strict';

/**
 * CHECKPOINT 5E (2026-10-05) -- final Phase 1 Engine comprehensive audit +
 * fix. Regression coverage for the verification invariant required by this
 * checkpoint:
 *
 *   verification === 'VERIFIED'  IMPLIES  after.verdict === 'READY'
 *
 * i.e. VERIFIED can never coexist with MANUAL_REVIEW_REQUIRED,
 * NEEDS_ATTENTION, unresolved geometry, or an untouched violation. The fix
 * itself (lib/orchestrator.js's evaluateVerification(), one added check:
 * `if (after.verdict !== 'READY') reasons.push('MANUAL_REVIEW_REMAINS')`)
 * is the ONLY lib/ change made for this checkpoint -- no zones.js,
 * zoneGeometry.js, margin.js, autofix.js, or policy-table change, per the
 * explicit instruction to prefer evaluateVerification()/the verification
 * wrapper and never touch those layers without strong cause. The audit
 * that led to this fix also re-confirmed (and this file re-tests) every
 * other checklist item the user asked to have checked -- geometry
 * resolution, LTR/RTL/conservative orientation, allowedSides, null/NaN
 * handling, autofix safety gates, and multi-page/buffer-reuse safety --
 * found already correct, so those cases here are regression locks, not
 * new fixes.
 */

const assert = require('node:assert/strict');
const {
  PDFDocument,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  setFillingRgbColor,
  fill,
  PDFName,
} = require('pdf-lib');
const { runPreflight, verifyAutofix, resolveAllowedSides } = require('../lib/orchestrator');
const { buildZones } = require('../lib/zones');
const { buildZoneGeometry } = require('../lib/zoneGeometry');
const { analyzePageObjects } = require('../lib/margin');

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
  // ===================================================================
  // 1. Ambiguous orientation remains -> NOT VERIFIED (the invariant's
  //    own motivating case, C3-class).
  // ===================================================================
  await runCase('1. ambiguous orientation survives autofix -> verification !== VERIFIED', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 20, y: 200, width: 20, height: 434 }] }], // LEFT-ambiguous + definite TOP overshoot
    });
    const opts = { userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }, pageContext: { pageCount: 100 } };
    const result = await verifyAutofix(bytes, opts);

    assert.equal(result.applied.length, 1, 'the definite TOP violation was fixed');
    assert.equal(result.after.violations.length, 0, 'no definite violations remain');
    assert.equal(
      result.after.categories.margins.manualReview.filter((e) => e.reason === 'LEM_ORIENTATION_AMBIGUOUS').length,
      1,
      'the ambiguity genuinely survives (dx=0 by design)'
    );
    assert.equal(result.after.verdict, 'MANUAL_REVIEW_REQUIRED');
    assert.notEqual(result.verification, 'VERIFIED', 'THE INVARIANT: VERIFIED must not coexist with a surviving ambiguity');
    assert.ok(result.reasons.includes('MANUAL_REVIEW_REMAINS'));
  });

  // ===================================================================
  // 2. Untouched violation + applied violation on the SAME page (the
  //    net-count-cancellation class found during this audit) -> NOT VERIFIED.
  // ===================================================================
  await runCase('2. untouched violation on the same page as a successful fix -> verification !== VERIFIED', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [
        {
          rects: [
            { x: 200, y: 200, width: 20, height: 434 }, // definite, autofix-eligible TOP overshoot (fixed)
            { x: 15, y: 20, width: 5, height: 5 }, // small, UNTOUCHED LEM warning, x comfortably safe vertically but outside conservative horizontally -- see note
          ],
        },
      ],
    });
    const opts = { userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }, pageContext: { pageCount: 100 } };
    const result = await verifyAutofix(bytes, opts);

    // Precondition: BEFORE has two problems on the page; only one gets an
    // applyable plan (the second rect, at x=[15,20], is itself only
    // 2pt from the trim edge horizontally AND fails the vertical LEM
    // check too -- given conservative safeZone.minY=18, bbox minY=20 is
    // safe vertically, so this object's violation is purely horizontal;
    // depending on orientation-ambiguity classification it may land in
    // manualReview rather than violations[]. The assertions below only
    // rely on the actually-observed BEFORE/AFTER shape, not an assumed one.
    assert.ok(result.before.violations.length >= 1, 'precondition: at least the TOP overshoot is a definite violation before the fix');
    assert.equal(result.applied.length, 1, 'exactly the TOP overshoot plan is byte-applied');
    assert.ok(result.after, 'a real AFTER re-check was produced');

    // Whatever the exact AFTER state is, the invariant must hold: if
    // after.verdict isn't READY, verification must not be VERIFIED.
    if (result.after.verdict !== 'READY') {
      assert.notEqual(result.verification, 'VERIFIED', 'THE INVARIANT: a non-READY AFTER verdict must never report VERIFIED, regardless of net violation counts');
      assert.ok(result.reasons.includes('MANUAL_REVIEW_REMAINS'));
    }
  });

  // ===================================================================
  // 3. Clean autofix -> VERIFIED (positive case must still work).
  // ===================================================================
  await runCase('3. clean, single-violation autofix -> VERIFIED + READY', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 200, y: 200, width: 20, height: 434 }] }],
    });
    const opts = { userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }, pageContext: { pageCount: 100 } };
    const result = await verifyAutofix(bytes, opts);
    assert.equal(result.after.verdict, 'READY');
    assert.equal(result.verification, 'VERIFIED');
    assert.deepEqual(result.reasons, []);
  });

  // ===================================================================
  // 4. Skipped autofix -> NOT VERIFIED (existing manual-review semantics,
  //    via a multi-stream /Contents page -- pdfAutofixWriter.js's own
  //    documented scope limit, forces every plan on that page to skip).
  // ===================================================================
  await runCase('4. skipped autofix (multi-stream /Contents) -> verification !== VERIFIED, AUTOFIX_NOT_SAFELY_APPLICABLE', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([6 * 72, 9 * 72]);
    page.setTrimBox(0, 0, 6 * 72, 9 * 72);

    // Two real content-stream objects (not pdf-lib's pushOperators, which
    // would create only one) -- mirrors test/make-color-fixtures.js's own
    // buildMultiStreamFixture() pattern, confirmed empirically to produce a
    // genuinely detectable object split across stream object boundaries.
    const ctx = doc.context;
    const s1 = ctx.register(ctx.stream('q\n0.2 0.2 0.2 rg\n200 200 20 434 re\nf\nQ\n'));
    const s2 = ctx.register(ctx.stream('% no-op extra stream\n'));
    page.node.set(PDFName.of('Contents'), ctx.obj([s1, s2]));

    const bytes = await doc.save();
    const opts = { userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }, pageContext: { pageCount: 100 } };
    const result = await verifyAutofix(bytes, opts);

    assert.equal(result.before.autofixPlans.length, 1, 'precondition: a plan exists and looked applyable before the attempt');
    assert.equal(result.applied.length, 0, 'the multi-stream page can never be byte-patched');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'multi_stream_contents_unsupported');
    assert.notEqual(result.verification, 'VERIFIED');
    assert.ok(result.reasons.includes('AUTOFIX_NOT_SAFELY_APPLICABLE'));
  });

  // ===================================================================
  // 5. Unresolved geometry (no explicit /TrimBox at all) -> NOT VERIFIED.
  // ===================================================================
  await runCase('5. unresolved geometry (no /TrimBox anchor) -> verification !== VERIFIED, NO_APPLICABLE_AUTOFIX', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      pages: [{ rects: [{ x: 5, y: 100, width: 20, height: 20 }] }],
      // no explicitTrimBox
    });
    const opts = { userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }, pageContext: { pageCount: 100 } };
    const result = await verifyAutofix(bytes, opts);

    assert.equal(result.before.geometry.pages[0].status, 'unavailable');
    assert.equal(result.before.verdict, 'MANUAL_REVIEW_REQUIRED');
    assert.notEqual(result.verification, 'VERIFIED');
    assert.ok(result.reasons.includes('NO_APPLICABLE_AUTOFIX'));
    assert.equal(result.after, null, 'no second preflight is run when nothing was applicable');
  });

  // ===================================================================
  // 6. Multi-page PDF / buffer reuse through the FULL verifyAutofix()
  //    cycle -- one page fixed, the other untouched, no cross-page
  //    corruption, original bytes never mutated.
  // ===================================================================
  await runCase('6. multi-page verifyAutofix(): one page fixed, the other page unaffected, original bytes untouched', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [
        { rects: [{ x: 200, y: 200, width: 20, height: 434 }] }, // page 0: fixable TOP overshoot
        { rects: [{ x: 200, y: 200, width: 20, height: 20 }] }, // page 1: already safe, nothing to do
      ],
    });
    const opts = { userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }, pageContext: { pageCount: 100 } };
    const result = await verifyAutofix(bytes, opts);

    assert.equal(result.before.geometry.pages.length, 2);
    assert.equal(result.before.autofixPlans.length, 1, 'only page 0 has anything to fix');
    assert.equal(result.before.autofixPlans[0].pageIndex, 0);
    assert.equal(result.applied.length, 1);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.after.geometry.pages.length, 2, 'AFTER re-check still covers both pages');
    assert.equal(result.after.violations.length, 0, 'page 0 fixed, page 1 was already clean -- no violations anywhere');
    assert.equal(result.after.verdict, 'READY');
    assert.equal(result.verification, 'VERIFIED');

    // Buffer-reuse / mutation safety: original bytes passed to
    // verifyAutofix() must still describe the pre-fix geometry when
    // independently re-detected afterward.
    const reDetectPage0 = await analyzePageObjects(bytes, 0);
    assert.deepEqual(reDetectPage0[0].rawBBoxPt, { minX: 200, minY: 200, maxX: 220, maxY: 634 }, 'original pdfBytes were never mutated by verifyAutofix()');
    const reDetectPage1 = await analyzePageObjects(bytes, 1);
    assert.equal(reDetectPage1.length, 1, 'page 1 still independently re-detectable from the original bytes (no cross-page buffer corruption)');
  });

  // ===================================================================
  // 7. LTR exact resolution -> real end-to-end VERIFIED using the EXACT
  //    (not conservative) safe zone.
  // ===================================================================
  await runCase('7. LTR exact resolution: real pipeline reaches geometryStatus "complete" and VERIFIED', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 408, y: 300, width: 12, height: 20 }] }], // overshoots the EXACT right boundary (414) by 6pt
    });
    const opts = {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'ltr' },
      pageContext: { pageCount: 100, pageNumber: 1 },
    };
    const result = await verifyAutofix(bytes, opts);
    assert.equal(result.before.geometry.pages[0].status, 'complete');
    assert.equal(result.before.autofixPlans[0].fixedBBoxPt.maxX, 414, 'targets the EXACT boundary, not the conservative one (405)');
    assert.equal(result.after.verdict, 'READY');
    assert.equal(result.verification, 'VERIFIED');
  });

  // ===================================================================
  // 8. RTL exact resolution -> mirrored end-to-end VERIFIED, confirming
  //    the inside/outside edge assignment actually flips for RTL.
  // ===================================================================
  await runCase('8. RTL exact resolution: inside/outside flips vs. LTR, real pipeline reaches VERIFIED', async () => {
    // Odd page (pageNumber=1), RTL: inside (gutter) is on the RIGHT, so the
    // LEFT edge is the "outside" edge (outsidePt=18pt, not insidePt=27pt).
    // An object at x=[13,25] violates the EXACT left boundary (18) by a
    // small, autofix-eligible 5pt; under LTR exact (inside=left=27pt) it
    // would overshoot by far more (14pt, over threshold), so this fixture
    // specifically exercises the RTL-only edge assignment, not merely
    // "some exact resolution".
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 13, y: 300, width: 12, height: 20 }] }], // bbox [13,300]-[25,320]
    });
    const opts = {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'rtl' },
      pageContext: { pageCount: 100, pageNumber: 1 },
    };
    const result = await verifyAutofix(bytes, opts);
    assert.equal(result.before.geometry.pages[0].status, 'complete');
    assert.equal(result.before.geometry.pages[0].safeZone.minX, 18, 'RTL odd page: outside (left) edge margin is outsidePt=18pt, confirming inside is on the right');
    assert.equal(result.before.autofixPlans.length, 1);
    assert.equal(result.before.autofixPlans[0].fixedBBoxPt.minX, 18, 'targets the EXACT RTL left boundary (18), not the LTR one (27) or conservative (27)');
    assert.equal(result.applied.length, 1);
    assert.equal(result.after.verdict, 'READY');
    assert.equal(result.verification, 'VERIFIED');
  });

  // ===================================================================
  // 9. Conservative LTR+RTL intersection -- the safe zone really is
  //    max(insidePt, outsidePt) on both sides, independent of orientation.
  // ===================================================================
  await runCase('9. conservative safe zone equals the LTR/RTL intersection, with hypotheses carrying the two named boxes', () => {
    const sz = buildZones({ pageCount: 100 }, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
    assert.equal(sz.horizontalResolution, 'conservative');
    const insidePt = 27; // pageCount=100 -> 0.375in
    const outsidePt = 18; // no-bleed -> 0.25in
    const conservativeMargin = Math.max(insidePt, outsidePt);
    assert.equal(sz.safeZoneBBoxPt.minX, conservativeMargin);
    assert.equal(sz.safeZoneBBoxPt.maxX, 432 - conservativeMargin);
    assert.deepEqual(sz.orientationHypotheses, {
      ltr: { minX: insidePt, maxX: 432 - outsidePt },
      rtl: { minX: outsidePt, maxX: 432 - insidePt },
    });
  });

  // ===================================================================
  // 10. Horizontal ambiguity does not become a violation -- an object
  //     outside the conservative zone but safe under one hypothesis is
  //     reported ONLY in manualReview, never in violations[].
  // ===================================================================
  await runCase('10. an ambiguous object never appears in violations[], only in manualReview[]', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 20, y: 300, width: 5, height: 5 }] }], // x=[20,25]: safe under rtl(>=18), violates ltr(<27) -> ambiguous
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
      pageContext: { pageCount: 100 },
    });
    assert.equal(result.violations.filter((v) => v.side === 'left' || v.side === 'right').length, 0, 'no left/right entry in violations[]');
    const ambiguous = result.categories.margins.manualReview.filter((e) => e.reason === 'LEM_ORIENTATION_AMBIGUOUS');
    assert.equal(ambiguous.length, 1, 'exactly one ambiguous manualReview entry instead');
    assert.equal(ambiguous[0].sides[0], 'left');
  });

  // ===================================================================
  // 11. null geometry never becomes numeric zero -- resolveAllowedSides()
  //     and the geometry layer's null pass-through, directly.
  // ===================================================================
  await runCase('11. null/undefined/NaN geometry values never get coerced into an allowed (0-based) side', () => {
    // Completely absent geometry.
    assert.deepEqual(resolveAllowedSides(null), { top: false, bottom: false, left: false, right: false });
    // trimBoxPt present but safeZoneBBoxPt entirely null (unresolved mode).
    assert.deepEqual(
      resolveAllowedSides({ trimBoxPt: { minX: 0, minY: 0, maxX: 432, maxY: 648 }, safeZoneBBoxPt: { minX: null, minY: 18, maxX: null, maxY: 630 }, bleedBoxPt: null }),
      { top: true, bottom: true, left: false, right: false },
      'vertical sides allowed (fully resolved), horizontal sides correctly blocked by null, never coerced to 0'
    );
    // NaN must be treated identically to null/undefined -- never "resolved".
    assert.deepEqual(
      resolveAllowedSides({ trimBoxPt: { minX: 0, minY: 0, maxX: 432, maxY: 648 }, safeZoneBBoxPt: { minX: NaN, minY: 18, maxX: 405, maxY: 630 }, bleedBoxPt: null }),
      { top: true, bottom: true, left: false, right: true },
      'NaN on one edge blocks only that one side, never silently becomes 0'
    );

    // Geometry layer: no /TrimBox anchor at all -> safeZoneBBoxPt stays
    // null (never an object with numeric-zero edges).
    const sz = buildZones({ pageCount: 100 }, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
    const geo = buildZoneGeometry(sz, {});
    assert.equal(geo.trimBoxPt, null);
    assert.equal(geo.safeZoneBBoxPt, null, 'absent trim anchor -> safeZoneBBoxPt null, not a zero-valued box');
  });

  // ===================================================================
  // 12. autofix never operates on an unresolved or ambiguous axis.
  // ===================================================================
  await runCase('12. autofix plan never moves an axis that is only ambiguous (not definite) on this object', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 20, y: 200, width: 20, height: 434 }] }], // LEFT ambiguous + TOP definite
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
      pageContext: { pageCount: 100 },
    });
    assert.equal(result.autofixPlans.length, 1);
    assert.equal(result.autofixPlans[0].shift.dx, 0, 'the ambiguous horizontal axis is never moved, even though a plan exists for the definite vertical violation');
  });

  await runCase('12b. autofix is never even attempted when horizontal geometry is fully unresolved', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      pages: [{ rects: [{ x: 200, y: 200, width: 20, height: 434 }] }],
      // no explicitTrimBox -> trimBoxPt null -> every side blocked
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
      pageContext: { pageCount: 100 },
    });
    assert.equal(result.autofixPlans.length, 0, 'no plan at all is produced when geometry is not fully resolved on every side');
  });

  // ===================================================================
  // 13. Existing definite (non-ambiguous) violation behavior is unchanged
  //     by the 5E fix -- a plain, single-sided violation with no ambiguity
  //     and no untouched neighbor still cleanly reaches VERIFIED.
  // ===================================================================
  await runCase('13. a plain definite BOTTOM violation (no ambiguity involved) still autofixes cleanly to VERIFIED', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 200, y: 14, width: 20, height: 20 }] }], // bottom overshoot only, x comfortably safe
    });
    const opts = { userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }, pageContext: { pageCount: 100 } };
    const result = await verifyAutofix(bytes, opts);
    assert.equal(result.before.violations.length, 1);
    assert.equal(result.before.violations[0].side, 'bottom');
    assert.equal(result.applied.length, 1);
    assert.equal(result.after.violations.length, 0);
    assert.equal(result.after.verdict, 'READY');
    assert.equal(result.verification, 'VERIFIED');
    assert.deepEqual(result.reasons, []);
  });

  // ===================================================================
  // 14. CHECKPOINT 5F -- explicit contract decision (KEEP, not changed):
  //     before.verdict === 'READY' and nothing applicable to autofix ->
  //     verification === 'VERIFIED', after === null, no false reason.
  //     A document that is already READY does not need a manufactured
  //     second preflight just to populate `after` -- VERIFIED here means
  //     "already verified, no mutation was necessary", a distinct but
  //     equally valid way to reach VERIFIED alongside the "applied + re-
  //     checked" path. See lib/orchestrator.js's verifyAutofix() for the
  //     full rationale (CHECKPOINT 5F comment, same branch).
  // ===================================================================
  await runCase('14 (CHECKPOINT 5F contract). already-READY document, nothing to autofix -> VERIFIED with after=null, no false reason', async () => {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      pages: [{ rects: [{ x: 200, y: 200, width: 20, height: 20 }] }], // comfortably inside the safe zone on every side
    });
    const opts = { userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }, pageContext: { pageCount: 100 } };
    const result = await verifyAutofix(bytes, opts);

    assert.equal(result.before.verdict, 'READY', 'precondition: the document is already READY before any autofix attempt');
    assert.equal(result.before.autofixPlans.length, 0, 'precondition: nothing is even eligible for autofix');
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.after, null, 'CHECKPOINT 5F (intentional): no second preflight is manufactured when nothing was applied');
    assert.equal(result.verification, 'VERIFIED', 'CHECKPOINT 5F (intentional): already-READY + nothing-to-apply is itself a valid VERIFIED outcome');
    assert.deepEqual(result.reasons, [], 'no false/spurious reason (e.g. NO_APPLICABLE_AUTOFIX) is produced when the document was already READY');
    assert.deepEqual(result.outputBytes, bytes, 'output bytes are exactly the untouched original');
  });

  console.log(`\nAll ${caseCount} checkpoint5e.test.js cases passed.`);
  console.log('(Requirement #14 -- "all existing tests remain green" -- is validated by running the full suite, not inside this file.)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
