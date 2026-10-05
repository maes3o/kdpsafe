'use strict';

const assert = require('node:assert/strict');
const { calculateSpineWidth, calculateCoverDimensions } = require('../lib/spine');

function approxEqual(actual, expected, tolerance, msg) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${msg}: expected ${expected} ± ${tolerance}, got ${actual}`
  );
}

// --- Spine width: known reference cases ---

// 300pp, white paper, paperback -> 300 * 0.002252 = 0.6756"
{
  const r = calculateSpineWidth({ pageCount: 300, paperType: 'white' });
  approxEqual(r.spineWidthIn, 0.6756, 0.0001, '300pp white spine width');
  assert.equal(r.spineTextAllowed, true, '300pp allows spine text');
}

// 24pp, white paper -> spine text NOT allowed (below 80pp)
{
  const r = calculateSpineWidth({ pageCount: 24, paperType: 'white' });
  assert.equal(r.spineTextAllowed, false, '24pp should not allow spine text');
  approxEqual(r.spineWidthIn, 24 * 0.002252, 0.0001, '24pp white spine width');
}

// exactly 80pp -> spine text allowed (boundary)
{
  const r = calculateSpineWidth({ pageCount: 80, paperType: 'cream' });
  assert.equal(r.spineTextAllowed, true, '80pp (boundary) should allow spine text');
  approxEqual(r.spineWidthIn, 80 * 0.0025, 0.0001, '80pp cream spine width');
}

// 79pp -> just below boundary, not allowed
{
  const r = calculateSpineWidth({ pageCount: 79, paperType: 'cream' });
  assert.equal(r.spineTextAllowed, false, '79pp should NOT allow spine text (conservative cutoff)');
}

// Hardcover adds 0.189"
{
  const paperback = calculateSpineWidth({ pageCount: 300, paperType: 'white', binding: 'paperback' });
  const hardcover = calculateSpineWidth({ pageCount: 300, paperType: 'white', binding: 'hardcover' });
  approxEqual(hardcover.spineWidthIn - paperback.spineWidthIn, 0.189, 0.0001, 'hardcover addition');
}

// Premium color multiplier
{
  const r = calculateSpineWidth({ pageCount: 150, paperType: 'premiumColor' });
  approxEqual(r.spineWidthIn, 150 * 0.002347, 0.0001, '150pp premiumColor spine width');
}

// Invalid inputs should throw
{
  assert.throws(() => calculateSpineWidth({ pageCount: 0, paperType: 'white' }), /positive integer/);
  assert.throws(() => calculateSpineWidth({ pageCount: 100, paperType: 'glossy' }), /Unknown paperType/);
  assert.throws(
    () => calculateSpineWidth({ pageCount: 100, paperType: 'white', binding: 'spiral' }),
    /binding must be/
  );
}

// --- Cover dimensions: 6x9 trim, 300pp white paperback ---
{
  const spine = calculateSpineWidth({ pageCount: 300, paperType: 'white' });
  const cover = calculateCoverDimensions({
    trimWidthIn: 6,
    trimHeightIn: 9,
    spineWidthIn: spine.spineWidthIn,
  });
  // total width = 0.125 + 6 + 0.6756 + 6 + 0.125 = 12.9256
  approxEqual(cover.totalWidthIn, 12.9256, 0.001, '6x9 300pp white full-wrap width');
  // total height = 9 + 2*0.125 = 9.25
  approxEqual(cover.totalHeightIn, 9.25, 0.001, '6x9 full-wrap height');

  // panel offsets should be internally consistent:
  // backPanelX + trimWidth == spinePanelX
  approxEqual(cover.spinePanelXIn - cover.backPanelXIn, 6, 0.0001, 'back panel width == trim width');
  // spinePanelX + spineWidth == frontPanelX
  approxEqual(cover.frontPanelXIn - cover.spinePanelXIn, spine.spineWidthIn, 0.0001, 'spine panel width == spine width');
  // frontPanelX + trimWidth + bleed == totalWidth
  approxEqual(cover.frontPanelXIn + 6 + cover.bleedIn, cover.totalWidthIn, 0.0001, 'front panel + trim + bleed == total width');
}

// No-bleed variant (e.g. for guide-only overlays)
{
  const cover = calculateCoverDimensions({
    trimWidthIn: 6,
    trimHeightIn: 9,
    spineWidthIn: 0.6756,
    includeBleed: false,
  });
  approxEqual(cover.totalWidthIn, 12.6756, 0.0001, 'no-bleed width');
  approxEqual(cover.totalHeightIn, 9, 0.0001, 'no-bleed height');
  assert.equal(cover.bleedIn, 0, 'no-bleed bleedIn should be 0');
}

console.log('All spine.js tests passed.');
