'use strict';

/**
 * CHECKPOINT 3 (2026-10-05): regression + end-to-end tests for
 * lib/orchestrator.js's runPreflight() and resolveAllowedSides(), plus the
 * additive allowedSides parameter on lib/margin.js's classifyViolations().
 *
 * Central thing under test: the CHECKPOINT 2 audit found that feeding
 * lib/zones.js's/lib/zoneGeometry.js's output (safeZoneBBoxPt.minX/maxX
 * always null in this architecture stage) directly into the pre-existing
 * classifyViolations() silently turned `null` into `0` via JS arithmetic
 * coercion -- dropping real left-margin violations and fabricating a
 * phantom right-side violation. Every test below exists to prove that
 * specific failure mode is now blocked, not just that the happy path works.
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
const { runPreflight, resolveAllowedSides, isResolvedNumber } = require('../lib/orchestrator');
const { classifyViolations } = require('../lib/margin');
const { buildZones } = require('../lib/zones');

function rectOps(x, y, w, h) {
  return [pushGraphicsState(), setFillingRgbColor(0.2, 0.2, 0.2), rectangle(x, y, w, h), fill(), popGraphicsState()];
}

// --- Part A: resolveAllowedSides() as a pure unit, independent of the PDF
// pipeline -- exercises every corner the user's refinement explicitly
// called out (null/undefined/NaN all UNKNOWN; no side assumed true by
// default; bleedBoxPt===null is NOT a failure, but a present bleedBoxPt
// with a null edge IS). ---

function partA_resolveAllowedSides() {
  // A1: fully resolved on all four sides -- every side allowed. This is a
  // hand-built geometry object (NOT what the real engine can produce yet,
  // since safeZoneBBoxPt's horizontal axis is permanently null in this
  // architecture stage -- see CHECKPOINT 2) specifically to prove
  // resolveAllowedSides() itself has no hidden assumption and correctly
  // allows left/right once they ARE resolved.
  {
    const geometry = {
      trimBoxPt: { minX: 0, minY: 0, maxX: 432, maxY: 648 },
      safeZoneBBoxPt: { minX: 27, minY: 18, maxX: 405, maxY: 630 },
      bleedBoxPt: null,
    };
    const allowed = resolveAllowedSides(geometry);
    assert.deepEqual(allowed, { top: true, bottom: true, left: true, right: true }, 'A1: fully resolved geometry allows all four sides');
  }

  // A2: the real engine's current shape -- vertical resolved, horizontal
  // null. top/bottom must be true ONLY because their OWN boundaries are
  // resolved -- not as a default.
  {
    const geometry = {
      trimBoxPt: { minX: 0, minY: 0, maxX: 432, maxY: 648 },
      safeZoneBBoxPt: { minX: null, minY: 18, maxX: null, maxY: 630 },
      bleedBoxPt: null,
    };
    const allowed = resolveAllowedSides(geometry);
    assert.deepEqual(allowed, { top: true, bottom: true, left: false, right: false }, 'A2: unresolved horizontal safe-zone blocks left/right only');
  }

  // A3: trimBoxPt itself entirely null (geometryStatus 'unavailable') --
  // every side blocked, including top/bottom, since trimBoxPt[edge] is
  // required for every side's comparison.
  {
    const geometry = { trimBoxPt: null, safeZoneBBoxPt: null, bleedBoxPt: null };
    const allowed = resolveAllowedSides(geometry);
    assert.deepEqual(allowed, { top: false, bottom: false, left: false, right: false }, 'A3: null trimBoxPt blocks every side, top/bottom included');
  }

  // A4: safeZoneBBoxPt present but one of its VERTICAL edges is NaN
  // (simulated float corruption) -- that side must be blocked even though
  // "top/bottom are usually known". NaN is UNKNOWN, not a passing value.
  {
    const geometry = {
      trimBoxPt: { minX: 0, minY: 0, maxX: 432, maxY: 648 },
      safeZoneBBoxPt: { minX: 27, minY: NaN, maxX: 405, maxY: 630 },
      bleedBoxPt: null,
    };
    const allowed = resolveAllowedSides(geometry);
    assert.deepEqual(allowed, { top: true, bottom: false, left: true, right: true }, 'A4: NaN on one edge blocks only the side that depends on it');
  }

  // A5: safeZoneBBoxPt.minY is `undefined` (missing key entirely) --
  // treated identically to null/NaN. UNKNOWN, not 0.
  {
    const geometry = {
      trimBoxPt: { minX: 0, minY: 0, maxX: 432, maxY: 648 },
      safeZoneBBoxPt: { minX: 27, maxX: 405, maxY: 630 }, // minY key omitted
      bleedBoxPt: null,
    };
    const allowed = resolveAllowedSides(geometry);
    assert.equal(allowed.bottom, false, 'A5: undefined edge is UNKNOWN, blocks that side');
  }

  // A6: bleedBoxPt is null (no-bleed intent) -- NOT a failure on its own;
  // does not block any side by itself (classifyViolations() already has
  // its own safe `if (!bleedBoxPt) continue` branch).
  {
    const geometry = {
      trimBoxPt: { minX: 0, minY: 0, maxX: 432, maxY: 648 },
      safeZoneBBoxPt: { minX: 27, minY: 18, maxX: 405, maxY: 630 },
      bleedBoxPt: null,
    };
    const allowed = resolveAllowedSides(geometry);
    assert.deepEqual(allowed, { top: true, bottom: true, left: true, right: true }, 'A6: bleedBoxPt===null does not block any side');
  }

  // A7: bleedBoxPt IS present but its horizontal edges are null (the real
  // engine's shape when bleed=true but inside/outside is unresolved) --
  // THIS must block left/right, distinct from A6's "absent entirely".
  {
    const geometry = {
      trimBoxPt: { minX: 0, minY: 0, maxX: 432, maxY: 648 },
      safeZoneBBoxPt: { minX: 27, minY: 18, maxX: 405, maxY: 630 }, // hypothetically resolved
      bleedBoxPt: { minX: null, minY: -9, maxX: null, maxY: 657 },
    };
    const allowed = resolveAllowedSides(geometry);
    assert.deepEqual(allowed, { top: true, bottom: true, left: false, right: false }, 'A7: present bleedBoxPt with null horizontal edges blocks left/right even though safeZoneBBoxPt itself is resolved there');
  }

  console.log('[Part A] resolveAllowedSides(): all 7 cases passed.');
}

// --- Part B: classifyViolations()'s new optional allowedSides param --
// backward compatibility + the exact null-coercion regression from
// CHECKPOINT 2, reproduced and now fixed. ---

function partB_classifyViolationsAllowedSides() {
  // The exact scenario from the CHECKPOINT 2 audit: 6x9in, no bleed.
  // CHECKPOINT 5C (2026-10-05) note: pageCount is deliberately left
  // MISSING here (not 100, as originally) so that insidePt stays
  // unresolved and safeZoneBBoxPt.minX/maxX stay `null` -- reproducing
  // the exact null-coercion scenario this Part exists to guard. With a
  // valid pageCount, CHECKPOINT 5C's conservative-zone resolution would
  // give safeZoneBBoxPt.minX/maxX real numbers, and the historical
  // null->0 bug this test demonstrates would no longer be reproducible
  // with this fixture (the object would instead just get a plain, real
  // left-margin violation -- see orchestrator.test.js Part C1/C3 for that
  // new, intended behavior). topPt/bottomPt are unaffected by pageCount
  // (never gutter-dependent), so Part B3's top-margin check below still
  // works unchanged.
  const semanticZones = buildZones({}, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
  const obj = {
    type: 'path',
    rawBBoxPt: { minX: 5, minY: 100, maxX: 25, maxY: 120 },
    visibleBBoxPt: { minX: 5, minY: 100, maxX: 25, maxY: 120 },
  };

  // B1: backward compatibility -- NO third argument at all reproduces the
  // exact pre-existing (buggy, when fed null-horizontal zones) behavior,
  // proving existing call sites are genuinely unaffected by this change.
  {
    const withoutAllowedSides = classifyViolations(obj, semanticZones);
    assert.equal(withoutAllowedSides.length, 1, 'B1: omitting allowedSides still runs (unchanged signature behavior)');
    assert.equal(withoutAllowedSides[0].side, 'right', 'B1: the known CHECKPOINT-2 bug (phantom right-side violation from null->0) is still reproducible when the new parameter is not used -- confirms the fix is opt-in via the gate, not a silent behavior change to the function itself');
  }

  // B2: THE FIX. Same object, same semanticZones, but with the safety
  // gate's allowedSides explicitly blocking left/right (as it would for
  // this exact semanticZones, since safeZoneBBoxPt.minX/maxX are null).
  {
    const allowedSides = { top: true, bottom: true, left: false, right: false };
    const result = classifyViolations(obj, semanticZones, allowedSides);
    assert.deepEqual(result, [], 'B2: with left/right blocked, NO violation is reported at all -- neither the (correct) left-side one nor the (phantom) right-side one. The object genuinely cannot be judged on the unresolved axis, and classifyViolations() no longer pretends otherwise.');
  }

  // B3: top/bottom keep working normally even while left/right are
  // blocked -- an object that genuinely violates the (resolved) top
  // margin must still be caught.
  {
    const topViolatingObj = {
      type: 'path',
      // safeZoneBBoxPt.maxY = trim.maxY(648) - topPt(18) = 630; this object
      // stays within TRIM (635 < 648, so it's a real LEM violation, not a
      // bleed case) but exceeds the safe-zone top edge by 5pt.
      rawBBoxPt: { minX: 200, minY: 100, maxX: 220, maxY: 635 },
      visibleBBoxPt: { minX: 200, minY: 100, maxX: 220, maxY: 635 },
    };
    const allowedSides = { top: true, bottom: true, left: false, right: false };
    const result = classifyViolations(topViolatingObj, semanticZones, allowedSides);
    assert.equal(result.length, 1, 'B3: a real top-margin violation is still caught when only top/bottom are allowed');
    assert.equal(result[0].side, 'top', 'B3: violation correctly attributed to top');
  }

  console.log('[Part B] classifyViolations(obj, zones, allowedSides): all 3 cases passed.');
}

// --- Part C: end-to-end runPreflight() ---

async function makeFixturePdf({ widthIn, heightIn, bleed, rects, explicitTrimBox, explicitBleedBox }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([widthIn * 72, heightIn * 72]);
  if (explicitTrimBox) page.setTrimBox(...explicitTrimBox);
  if (explicitBleedBox) page.setBleedBox(...explicitBleedBox);
  for (const r of rects || []) {
    page.pushOperators(...rectOps(r.x, r.y, r.width, r.height));
  }
  return doc.save();
}

async function partC_endToEnd() {
  // C1: a document with a deep-left-margin violation (6x9in, no bleed,
  // explicit consistent /TrimBox, pageCount=100 -> insidePt=27pt,
  // outsidePt=18pt).
  //
  // CHECKPOINT 5C (2026-10-05) UPDATE: this case's expected result
  // changed, deliberately and as the explicit purpose of CHECKPOINT 5C --
  // without userIntent.readingDirection, horizontalResolution is now
  // 'conservative' (not permanently unresolved), so left/right are no
  // longer blocked by HORIZONTAL_GEOMETRY_UNRESOLVED on a bleed=false
  // page. This object (bbox x:[5,25]) sits outside BOTH named orientation
  // hypotheses (conservative=[27,405], ltr=[27,414], rtl=[18,405] -- fails
  // ltr since 5<27, fails rtl since 5<18) -- CASE C, a DEFINITE violation
  // (CHECKPOINT 5B), independent of binding orientation. It must still be
  // caught -- the thing CHECKPOINT 2's audit guarded against was a
  // PHANTOM right-side violation / a MISSED left-side one, not "no
  // violation is ever possible on these sides".
  {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      rects: [{ x: 5, y: 100, width: 20, height: 20 }], // deep in the left margin
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
      pageContext: { pageCount: 100 },
    });

    assert.equal(result.geometry.status, 'partial', "C1: geometryStatus is 'partial' -- conservative resolution, not exact, so 'complete' must not be claimed");
    assert.equal(result.geometry.pages[0].allowedSides.left, true, 'C1: left is now allowed -- conservative safe zone is resolved and bleed=false');
    assert.equal(result.geometry.pages[0].allowedSides.right, true, 'C1: right is now allowed for the same reason');
    assert.equal(result.geometry.pages[0].allowedSides.top, true, 'C1: top is allowed (vertical axis resolved, unaffected)');
    assert.equal(result.geometry.pages[0].allowedSides.bottom, true, 'C1: bottom is allowed');

    const leftOrRightViolations = result.violations.filter((v) => v.side === 'left' || v.side === 'right');
    assert.equal(leftOrRightViolations.length, 1, 'C1: exactly one left/right violation -- the genuine, definite left-margin one');
    assert.equal(leftOrRightViolations[0].side, 'left', 'C1: correctly attributed to left -- no phantom right-side violation (the exact CHECKPOINT 2 bug), and no false negative on left either');
    assert.equal(leftOrRightViolations[0].violation, 'LEM');
    assert.equal(Math.round(leftOrRightViolations[0].amountPt), 22, 'C1: amountPt is the conservative-boundary overshoot (27pt conservative margin - 5pt object edge)');

    assert.ok(!result.categories.margins.manualReview.some((e) => e.reason === 'HORIZONTAL_GEOMETRY_UNRESOLVED'), 'C1: geometry is no longer unresolved on this bleed=false page');
    assert.ok(!result.categories.margins.manualReview.some((e) => e.reason === 'LEM_ORIENTATION_AMBIGUOUS'), 'C1: this object is a DEFINITE violation, not ambiguous -- it must not appear as ambiguous');
    assert.equal(result.verdict, 'MANUAL_REVIEW_REQUIRED', "C1: a 22pt LEM overshoot exceeds the autofix threshold (7.2pt) -> severity 'error' -> manual_review, same final verdict as before, now for the correct, specific reason");
  }

  // C2: missing userIntent entirely -- geometry unavailable, every side
  // blocked, verdict MANUAL_REVIEW_REQUIRED, reason is explicit.
  {
    const bytes = await makeFixturePdf({ widthIn: 6, heightIn: 9, rects: [] });
    const result = await runPreflight(bytes, { userIntent: {}, pageContext: { pageCount: 100 } });

    assert.equal(result.geometry.status, 'unavailable', 'C2: geometryStatus unavailable without trim/bleed intent');
    assert.deepEqual(result.geometry.pages[0].allowedSides, { top: false, bottom: false, left: false, right: false }, 'C2: every side blocked');
    assert.equal(result.verdict, 'MANUAL_REVIEW_REQUIRED', 'C2: verdict is MANUAL_REVIEW_REQUIRED');
  }

  // C3: an object well inside the CONSERVATIVE zone.
  //
  // CHECKPOINT 5C (2026-10-05) UPDATE: this is the exact, intended payoff
  // of Option C/5A/5B -- this assertion is DELIBERATELY FLIPPED from its
  // pre-5C form. Before CHECKPOINT 5C, "zero detected violations" could
  // never mean READY on a bleed=false page, because the horizontal axis
  // was permanently unresolved (null != unknown-but-safe). Now,
  // object ⊆ conservativeZone is mathematically proven (CHECKPOINT 5A) to
  // mean "safe under BOTH possible orientations" -- a genuinely known-safe
  // fact, not an absence of information. A page with no violations and no
  // ambiguous objects on a bleed=false document must reach READY.
  {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      rects: [{ x: 200, y: 200, width: 20, height: 20 }], // comfortably inside every known margin
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
      pageContext: { pageCount: 100 },
    });

    assert.equal(result.violations.length, 0, 'C3: no violation is detected');
    assert.equal(result.categories.margins.manualReview.length, 0, 'C3: no manual-review entry either -- object is SAFE under both orientations, not merely unresolved');
    assert.equal(result.verdict, 'READY', 'C3: verdict IS READY -- the conservative zone proves this object safe under both possible binding orientations (CHECKPOINT 5A)');
    assert.equal(result.categories.margins.status, 'ready', 'C3: margins category itself reflects this');
  }

  // C3b: the SAME conservative zone also correctly produces AMBIGUOUS
  // (not safe, not a definite violation) for an object that is safe under
  // exactly one of the two named orientation hypotheses -- the CHECKPOINT
  // 5B contract's CASE B, exercised through the real pipeline end-to-end.
  // insidePt=27pt, outsidePt=18pt, conservative=[27,405], ltr=[27,414],
  // rtl=[18,405]. An object at x:[20,40] fails ltr (20<27) but passes rtl
  // (20>=18 and 40<=405) -- safe under rtl only.
  {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      explicitTrimBox: [0, 0, 432, 648],
      rects: [{ x: 20, y: 200, width: 20, height: 20 }], // x:[20,40] -- safe under RTL only
    });
    const result = await runPreflight(bytes, {
      userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
      pageContext: { pageCount: 100 },
    });

    assert.equal(result.violations.length, 0, 'C3b: an AMBIGUOUS object must NEVER appear in violations[]');
    const ambiguous = result.categories.margins.manualReview.filter((e) => e.reason === 'LEM_ORIENTATION_AMBIGUOUS');
    assert.equal(ambiguous.length, 1, 'C3b: exactly one LEM_ORIENTATION_AMBIGUOUS manualReview entry');
    assert.equal(ambiguous[0].sides[0], 'left');
    assert.deepEqual(ambiguous[0].orientation, { ltr: 'violation', rtl: 'safe' }, 'C3b: preserves exactly which hypothesis passes/fails');
    assert.equal(result.verdict, 'MANUAL_REVIEW_REQUIRED', 'C3b: ambiguous forces manual review, never READY and never a silent violation');
  }

  console.log('[Part C] runPreflight() end-to-end: all 3 cases passed.');
}

async function main() {
  partA_resolveAllowedSides();
  partB_classifyViolationsAllowedSides();
  await partC_endToEnd();

  // Sanity: isResolvedNumber() itself, since every other test depends on it.
  assert.equal(isResolvedNumber(null), false);
  assert.equal(isResolvedNumber(undefined), false);
  assert.equal(isResolvedNumber(NaN), false);
  assert.equal(isResolvedNumber(0), true);
  assert.equal(isResolvedNumber(-5.5), true);

  console.log('\nAll orchestrator.test.js cases passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
