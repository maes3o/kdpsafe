'use strict';

/**
 * Margin/Bleed/LEM detection-only expansion (2026-10-05): systematic
 * fixture coverage for lib/margin.js's new classifyViolations(), across
 * text/image/path types, LEM-boundary ladder, intentional vs. partial
 * bleed, rotation, nested q/Q, nested Form XObjects, and clipping.
 *
 * Standing constraints honored here (per the task that opened this
 * stage): no PDF rewrite/autofix anywhere in this file -- detection and
 * diagnostics only; the clipping engine's AABB approximation is not
 * expanded (still axis-aligned, per margin.js's file-header scope note).
 */

const assert = require('node:assert/strict');
const { analyzePageObjects, classifyViolations, TOLERANCE_PT, LEM_AUTOFIX_THRESHOLD_PT } = require('../lib/margin');
const { zones, safeZoneBBoxPt, trimBoxPt, bleedBoxPt } = require('./zones');
const {
  buildPathCasesFixture,
  buildRotatedPathFixture,
  buildNestedSaveRestoreFixture,
  buildClippedSafeFixture,
  buildTextCasesFixture,
  buildImageCasesFixture,
} = require('./make-safezone-fixtures');
const { buildFormXObjectFixture } = require('./make-form-xobject-fixture');

function closeBBox(a, b, tol = 0.01) {
  return (
    Math.abs(a.minX - b.minX) < tol &&
    Math.abs(a.minY - b.minY) < tol &&
    Math.abs(a.maxX - b.maxX) < tol &&
    Math.abs(a.maxY - b.maxY) < tol
  );
}

function findSide(violations, side) {
  return violations.find((v) => v.side === side);
}

async function run() {
  let testCount = 0;

  // --- Path cases: the 7-case fixture, including the 4-rung LEM
  // boundary ladder (exactly-on-LEM / minimal overshoot / exactly 0.1in /
  // slightly more than 0.1in) and intentional-vs-partial bleed. ---
  {
    const { bytes, labels } = await buildPathCasesFixture();
    const results = await analyzePageObjects(bytes, 0);
    assert.equal(results.length, labels.length, '[path-cases] one path object per case expected');

    const byLabel = {};
    labels.forEach((label, i) => {
      byLabel[label] = classifyViolations(results[i], zones);
    });

    // (a) Fully inside LEM -- zero violations.
    assert.deepEqual(byLabel['safe-inside-lem'], [], '[a] fully-inside-LEM rect must have zero violations');
    testCount++;

    // (b) Exactly on the LEM line -- within tolerance, still safe.
    assert.deepEqual(byLabel['exactly-on-lem'], [], '[b] rect sitting exactly on the LEM boundary must be safe (tolerance)');
    testCount++;

    // (c) Minimal real overshoot (1pt) -- a genuine LEM violation, small
    // enough to stay 'warning' (well under the 7.2pt autofix threshold).
    {
      const v = byLabel['minimal-overshoot-lem'];
      assert.equal(v.length, 1, '[c] minimal overshoot should produce exactly one violation');
      assert.equal(v[0].violation, 'LEM');
      assert.equal(v[0].side, 'left');
      assert.equal(v[0].severity, 'warning');
      assert.ok(v[0].amountPt > TOLERANCE_PT && v[0].amountPt < 2, `[c] amountPt should be ~1pt, got ${v[0].amountPt}`);
      testCount++;
    }

    // (d) Exactly 0.1in (7.2pt) overshoot -- the threshold boundary
    // itself, inclusive: still 'warning' (autofix.js's own cutoff is a
    // strict >, so equality stays autofix-eligible).
    {
      const v = byLabel['exactly-0.1in-overshoot-lem'];
      assert.equal(v.length, 1, '[d] exactly-0.1in overshoot should produce exactly one violation');
      assert.equal(v[0].violation, 'LEM');
      assert.equal(v[0].severity, 'warning', '[d] exactly at the threshold must still be "warning"');
      assert.ok(Math.abs(v[0].amountPt - LEM_AUTOFIX_THRESHOLD_PT) < 0.01, `[d] amountPt should be ~7.2pt, got ${v[0].amountPt}`);
      testCount++;
    }

    // (e) Slightly more than 0.1in -- now 'error'.
    {
      const v = byLabel['over-0.1in-overshoot-lem'];
      assert.equal(v.length, 1, '[e] over-0.1in overshoot should produce exactly one violation');
      assert.equal(v[0].violation, 'LEM');
      assert.equal(v[0].severity, 'error', '[e] past the threshold must be "error"');
      assert.ok(v[0].amountPt > LEM_AUTOFIX_THRESHOLD_PT, `[e] amountPt should exceed 7.2pt, got ${v[0].amountPt}`);
      testCount++;
    }

    // (f) Intentional full bleed -- touches trim, reaches the bleed edge: safe.
    assert.deepEqual(byLabel['full-bleed-safe'], [], '[f] a rect that properly bleeds to the bleed edge must have zero violations');
    testCount++;

    // (g) Partial bleed -- crosses trim, falls short of the bleed edge: BLEED/error.
    {
      const v = byLabel['partial-bleed-violation'];
      assert.equal(v.length, 1, '[g] partial bleed should produce exactly one violation');
      assert.equal(v[0].violation, 'BLEED');
      assert.equal(v[0].side, 'left');
      assert.equal(v[0].severity, 'error', '[g] a bleed gap is always "error" -- no autofix path exists for it');
      assert.ok(v[0].amountPt > 0, `[g] amountPt should be a positive gap, got ${v[0].amountPt}`);
      testCount++;
    }

    console.log(`[path-cases] all ${labels.length} path-object LEM/Bleed categories classified as expected.`);
  }

  // --- Rotated path: AABB-approximation boundary, reused as-is from the
  // Form XObject regression (no new clipping geometry). ---
  {
    const { bytes, expectedRawBBoxPt } = await buildRotatedPathFixture();
    const results = await analyzePageObjects(bytes, 0);
    assert.equal(results.length, 1, '[rotated] exactly one path object expected');
    const [obj] = results;
    assert.ok(closeBBox(obj.rawBBoxPt, expectedRawBBoxPt), `[rotated] rawBBoxPt mismatch: ${JSON.stringify(obj.rawBBoxPt)} vs ${JSON.stringify(expectedRawBBoxPt)}`);

    const violations = classifyViolations(obj, zones);
    // The rotated square's AABB was deliberately placed to poke out past
    // the LEM boundary on its lower-left -- expect LEM violations on (at
    // least) the sides whose boundary the AABB actually crosses.
    const expectLeft = expectedRawBBoxPt.minX < safeZoneBBoxPt.minX - TOLERANCE_PT;
    const expectBottom = expectedRawBBoxPt.minY < safeZoneBBoxPt.minY - TOLERANCE_PT;
    assert.ok(expectLeft || expectBottom, '[rotated] sanity: fixture must actually cross the LEM boundary on at least one side');
    if (expectLeft) assert.ok(findSide(violations, 'left'), '[rotated] expected a LEM violation on the left side');
    if (expectBottom) assert.ok(findSide(violations, 'bottom'), '[rotated] expected a LEM violation on the bottom side');
    for (const v of violations) assert.equal(v.violation, 'LEM', '[rotated] no side of this fixture should cross trim, only LEM');
    testCount++;
    console.log('[rotated] rotated-AABB path correctly classified against the LEM boundary:', JSON.stringify(violations.map((v) => ({ side: v.side, amountPt: Math.round(v.amountPt * 100) / 100 }))));
  }

  // --- Nested q/Q: CTM stack must restore correctly across nesting. ---
  {
    const { bytes, expectedInnerBBoxPt, expectedOuterOnlyBBoxPt } = await buildNestedSaveRestoreFixture();
    const results = await analyzePageObjects(bytes, 0);
    assert.equal(results.length, 2, '[nested-qQ] exactly two path objects expected');
    const [inner, outerOnly] = results;
    assert.ok(closeBBox(inner.rawBBoxPt, expectedInnerBBoxPt), `[nested-qQ] inner-scope rect bbox mismatch: ${JSON.stringify(inner.rawBBoxPt)} vs ${JSON.stringify(expectedInnerBBoxPt)}`);
    assert.ok(closeBBox(outerOnly.rawBBoxPt, expectedOuterOnlyBBoxPt), `[nested-qQ] outer-only rect bbox mismatch (inner transform leaked?): ${JSON.stringify(outerOnly.rawBBoxPt)} vs ${JSON.stringify(expectedOuterOnlyBBoxPt)}`);
    // Both rects are comfortably inside the safe zone by construction --
    // zero violations confirms this is purely a CTM-restoration check.
    assert.deepEqual(classifyViolations(inner, zones), [], '[nested-qQ] inner rect should be safe');
    assert.deepEqual(classifyViolations(outerOnly, zones), [], '[nested-qQ] outer-only rect should be safe');
    testCount++;
    console.log('[nested-qQ] nested save/restore correctly restores the CTM at each level.');
  }

  // --- Clipping: raw path violates LEM (and touches trim), but the
  // VISIBLE (clipped) extent is fully safe -- classification must use
  // visibleBBoxPt, not rawBBoxPt. ---
  {
    const { bytes } = await buildClippedSafeFixture();
    const results = await analyzePageObjects(bytes, 0);
    assert.equal(results.length, 1, '[clipping] exactly one path object expected');
    const [obj] = results;
    const rawViolations = classifyViolations({ ...obj, visibleBBoxPt: obj.rawBBoxPt }, zones);
    assert.ok(rawViolations.length > 0, '[clipping] sanity: the RAW bbox must actually violate something, or this fixture proves nothing');
    const visibleViolations = classifyViolations(obj, zones);
    assert.deepEqual(visibleViolations, [], '[clipping] the clipped VISIBLE bbox must be classified safe');
    testCount++;
    console.log('[clipping] raw-vs-visible distinction confirmed: a clip can resolve an apparent LEM/trim violation.');
  }

  // --- Text: qualitative LEM/Bleed classification, with text's own
  // "always error" severity rule for LEM. ---
  {
    const { bytes, labels } = await buildTextCasesFixture();
    const results = await analyzePageObjects(bytes, 0);
    assert.equal(results.length, labels.length, '[text-cases] one text object per case expected');
    const byLabel = {};
    labels.forEach((label, i) => {
      byLabel[label] = classifyViolations(results[i], zones);
    });

    assert.deepEqual(byLabel['text-inside-lem'], [], '[text-inside-lem] should have zero violations');
    testCount++;

    {
      const v = byLabel['text-crossing-lem'];
      assert.equal(v.length, 1, '[text-crossing-lem] expected exactly one violation');
      assert.equal(v[0].violation, 'LEM');
      assert.equal(v[0].side, 'bottom');
      assert.equal(v[0].severity, 'error', '[text-crossing-lem] text LEM violations are always "error"');
      testCount++;
    }

    {
      const v = byLabel['text-past-trim'];
      assert.equal(v.length, 1, '[text-past-trim] expected exactly one violation');
      assert.equal(v[0].violation, 'BLEED');
      assert.equal(v[0].side, 'bottom');
      assert.equal(v[0].severity, 'error');
      testCount++;
    }

    console.log('[text-cases] text LEM/Bleed classification (approximate glyph-box geometry) matches expectations.');
  }

  // --- Images: normal / full-bleed (safe) / partial-bleed (violation). ---
  {
    const { bytes, labels } = await buildImageCasesFixture();
    const results = await analyzePageObjects(bytes, 0);
    assert.equal(results.length, labels.length, '[image-cases] one image object per case expected');
    const byLabel = {};
    labels.forEach((label, i) => {
      byLabel[label] = classifyViolations(results[i], zones);
    });

    assert.deepEqual(byLabel['image-safe-inside-lem'], [], '[image-safe-inside-lem] should have zero violations');
    testCount++;
    assert.deepEqual(byLabel['image-full-bleed-safe'], [], '[image-full-bleed-safe] a properly bleeding image should have zero violations');
    testCount++;

    {
      const v = byLabel['image-partial-bleed-violation'];
      assert.equal(v.length, 1, '[image-partial-bleed-violation] expected exactly one violation');
      assert.equal(v[0].violation, 'BLEED');
      assert.equal(v[0].severity, 'error');
      testCount++;
    }

    console.log('[image-cases] image LEM/Bleed classification matches expectations.');
  }

  // --- Nested Form XObjects: a LEM violation detected through a Form's
  // own Matrix+BBox scoping (reuses the Color/Margin architecture-
  // inventory Form XObject fixture builder, just placed to cross LEM). ---
  {
    const px = safeZoneBBoxPt.minX - 15;
    const py = safeZoneBBoxPt.minY + 20;
    const { bytes } = await buildFormXObjectFixture({
      formBBox: { x: 0, y: 0, width: 50, height: 50 },
      rectInForm: { x: 10, y: 10, width: 30, height: 30 }, // fully inside the Form's own BBox -- no extra clip
      placement: { x: px, y: py, scale: 1 },
      mainPageSize: require('./zones').mediaBoxSize,
    });
    const results = await analyzePageObjects(bytes, 0);
    assert.equal(results.length, 1, '[nested-form] exactly one path object expected');
    const [obj] = results;
    const expectedBBoxPt = { minX: px + 10, minY: py + 10, maxX: px + 40, maxY: py + 40 };
    assert.ok(closeBBox(obj.visibleBBoxPt, expectedBBoxPt), `[nested-form] bbox mismatch: ${JSON.stringify(obj.visibleBBoxPt)} vs ${JSON.stringify(expectedBBoxPt)}`);

    const violations = classifyViolations(obj, zones);
    assert.equal(violations.length, 1, '[nested-form] expected exactly one LEM violation');
    assert.equal(violations[0].violation, 'LEM');
    assert.equal(violations[0].side, 'left');
    assert.equal(violations[0].severity, 'warning');
    testCount++;
    console.log('[nested-form] a LEM violation placed inside a Form XObject is correctly detected through the Form scope:', JSON.stringify({ side: violations[0].side, amountPt: Math.round(violations[0].amountPt * 100) / 100 }));
  }

  console.log(`\nAll margin-violations.test.js tests passed (${testCount} assertions across 7 fixtures, 16 individually-asserted cases).`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
