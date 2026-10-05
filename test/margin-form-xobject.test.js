'use strict';

/**
 * Regression test for margin.js's paintFormXObjectBegin/End handling
 * (2026-10-04 architecture-inventory finding): a Form XObject's own
 * Matrix must be applied to the CTM, and its content must be clipped to
 * its own /BBox -- both previously silently ignored (see margin.js's
 * comment on this case for the full write-up).
 */

const assert = require('node:assert/strict');
const { analyzePageObjects } = require('../lib/margin');
const { buildFormXObjectFixture } = require('./make-form-xobject-fixture');

function closeBBox(a, b, tol = 0.01) {
  return (
    Math.abs(a.minX - b.minX) < tol &&
    Math.abs(a.minY - b.minY) < tol &&
    Math.abs(a.maxX - b.maxX) < tol &&
    Math.abs(a.maxY - b.maxY) < tol
  );
}

async function run() {
  // --- 1) Content overflowing the Form's own BBox must be clipped to it:
  // rawBBoxPt stays the unclipped geometric extent, visibleBBoxPt is cut
  // down to the Form's BBox (transformed by the placement cm). ---
  {
    const { bytes, expectedRawBBoxPt, expectedVisibleBBoxPt } = await buildFormXObjectFixture({
      formBBox: { x: 0, y: 0, width: 50, height: 50 },
      rectInForm: { x: -20, y: -20, width: 100, height: 100 },
      placement: { x: 100, y: 100, scale: 2 },
    });
    const results = await analyzePageObjects(new Uint8Array(bytes), 0);
    assert.equal(results.length, 1, '[1] exactly one path object expected');
    const [obj] = results;
    assert.ok(closeBBox(obj.rawBBoxPt, expectedRawBBoxPt), `[1] rawBBoxPt mismatch: ${JSON.stringify(obj.rawBBoxPt)} vs ${JSON.stringify(expectedRawBBoxPt)}`);
    assert.ok(closeBBox(obj.visibleBBoxPt, expectedVisibleBBoxPt), `[1] visibleBBoxPt mismatch: ${JSON.stringify(obj.visibleBBoxPt)} vs ${JSON.stringify(expectedVisibleBBoxPt)}`);
    // Sanity: this fixture is only meaningful if raw and visible actually
    // differ (i.e. the BBox clip did something) -- otherwise a bug that
    // skips clipping entirely could still pass by accident.
    assert.notDeepEqual(obj.rawBBoxPt, obj.visibleBBoxPt, '[1] raw and visible bbox must differ when content overflows the Form BBox');
    console.log('[1] Form XObject content overflowing its own BBox is correctly clipped.');
  }

  // --- 2) Content fully WITHIN the Form's own BBox must be unaffected --
  // raw and visible bbox should match (no spurious clipping of in-bounds
  // content). ---
  {
    const { bytes, expectedRawBBoxPt, expectedVisibleBBoxPt } = await buildFormXObjectFixture({
      formBBox: { x: 0, y: 0, width: 50, height: 50 },
      rectInForm: { x: 10, y: 10, width: 20, height: 20 },
      placement: { x: 100, y: 100, scale: 2 },
    });
    const results = await analyzePageObjects(new Uint8Array(bytes), 0);
    assert.equal(results.length, 1, '[2] exactly one path object expected');
    const [obj] = results;
    assert.ok(closeBBox(obj.rawBBoxPt, expectedRawBBoxPt), '[2] rawBBoxPt mismatch');
    assert.ok(closeBBox(obj.visibleBBoxPt, expectedVisibleBBoxPt), '[2] visibleBBoxPt mismatch');
    assert.ok(closeBBox(obj.rawBBoxPt, obj.visibleBBoxPt), '[2] in-bounds content must not be clipped at all');
    console.log('[2] Form XObject content fully within its own BBox is left unclipped.');
  }

  // --- 3) Rotated Form placement (regression fixture requested 2026-10-04
  // to lock in the current AABB-approximation boundary, not to add exact
  // rotated-polygon clipping): the Form's BBox and its overflowing content
  // are both rotated 30deg via drawPage's `rotate` option. margin.js only
  // ever tracks axis-aligned bboxes (file-header scope note, unchanged),
  // so both rawBBoxPt and the clip boundary become the AABB of the
  // rotated corners -- a real approximation of what would, in exact
  // geometry, be two overlapping rotated rectangles. This test pins that
  // specific, known-approximate behavior with real numbers so a future
  // change to exact clipping geometry is a deliberate, visible decision,
  // not a silent regression. ---
  {
    const { bytes, expectedRawBBoxPt, expectedVisibleBBoxPt } = await buildFormXObjectFixture({
      formBBox: { x: 0, y: 0, width: 50, height: 50 },
      rectInForm: { x: -20, y: -20, width: 100, height: 100 },
      placement: { x: 200, y: 200, scale: 1, rotateDegrees: 30 },
    });
    const results = await analyzePageObjects(new Uint8Array(bytes), 0);
    assert.equal(results.length, 1, '[3] exactly one path object expected');
    const [obj] = results;
    assert.ok(closeBBox(obj.rawBBoxPt, expectedRawBBoxPt), `[3] rawBBoxPt mismatch: ${JSON.stringify(obj.rawBBoxPt)} vs ${JSON.stringify(expectedRawBBoxPt)}`);
    assert.ok(closeBBox(obj.visibleBBoxPt, expectedVisibleBBoxPt), `[3] visibleBBoxPt mismatch: ${JSON.stringify(obj.visibleBBoxPt)} vs ${JSON.stringify(expectedVisibleBBoxPt)}`);
    assert.notDeepEqual(obj.rawBBoxPt, obj.visibleBBoxPt, '[3] the rotated BBox clip must still narrow the overflowing content\'s AABB');
    console.log('[3] Rotated Form XObject placement -- AABB-approximation boundary pinned:', JSON.stringify({ rawBBoxPt: obj.rawBBoxPt, visibleBBoxPt: obj.visibleBBoxPt }));
  }

  console.log('All margin-form-xobject.test.js tests passed.');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
