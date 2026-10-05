'use strict';

/**
 * Fixtures for the detection/autofix validation checkpoint (2026-10-05,
 * requested explicitly BEFORE any integration code is written) --
 * targeted at the one structural conflict found while designing the
 * detection -> aggregation -> autofix boundary (see this session's
 * design notes): lib/autofix.js's planAutofix() gates its WHOLE decision
 * on touchedPageEdges()/checkBleedCoverage() the instant ANY side
 * touches the trim boundary, and never falls through to check the other,
 * non-touching sides against the LEM zone at all. lib/margin.js's
 * classifyViolations() is per-side and has no such blind spot.
 *
 * Each builder below is deliberately a single page / single rect, same
 * minimal style as make-safezone-fixtures.js's buildPathCasesFixture(),
 * so each fixture's geometry is traceable by hand against test/zones.js
 * (trimBoxPt 9..441 x 9..657, safeZoneBBoxPt 45..405 x 45..621,
 * bleedBoxPt 0..450 x 0..666) rather than asserted blindly.
 */

const { PDFDocument, pushGraphicsState, popGraphicsState, rectangle, setFillingRgbColor, fill } = require('pdf-lib');
const { mediaBoxSize } = require('./zones');

function rectOps(x, y, w, h) {
  return [
    pushGraphicsState(),
    setFillingRgbColor(0.2, 0.2, 0.2),
    rectangle(x, y, w, h),
    fill(),
    popGraphicsState(),
  ];
}

async function buildSingleRectFixture(rect) {
  const doc = await PDFDocument.create();
  const page = doc.addPage(mediaBoxSize);
  page.pushOperators(...rectOps(rect.x, rect.y, rect.width, rect.height));
  const bytes = await doc.save();
  return { bytes };
}

/**
 * GROUP A -- edge-touch + untouched-side LEM (the known mismatch).
 *
 * Left side: minX = 0, i.e. touches trim (trimBoxPt.minX = 9, within
 * EDGE_TOUCH_TOLERANCE_PT=1 is NOT even required here -- 0 is well past
 * it) and reaches exactly to the bleed edge (bleedBoxPt.minX = 0) -->
 * classifyViolations: intentional bleed, no violation on this side;
 * planAutofix's checkBleedCoverage: no gap on this (the only touched)
 * side either.
 *
 * Top side: maxY = 635, i.e. 14pt past safeZoneBBoxPt.maxY (621) --
 * above the 7.2pt autofix threshold, so 'error' -- but 635 is still 21pt
 * short of trimBoxPt.maxY (657), well outside EDGE_TOUCH_TOLERANCE_PT,
 * so this side does NOT touch trim and is invisible to
 * touchedPageEdges()/checkBleedCoverage().
 *
 * Right (maxX=100) and bottom (minY=200) are both comfortably inside the
 * safe zone (safeZoneBBoxPt: 45..405 x 45..621) -- no violation, no
 * trim-touch, on either side.
 */
async function buildEdgeTouchUntouchedLemFixture() {
  const rect = { x: 0, y: 200, width: 100, height: 435 }; // minX=0, maxX=100, minY=200, maxY=635
  const { bytes } = await buildSingleRectFixture(rect);
  return { bytes, rect };
}

/**
 * GROUP B -- multi-side LEM, both sides 'warning' (<= 7.2pt), neither
 * side touching trim.
 *
 * Left: minX = 40 -> safeZoneBBoxPt.minX(45) - 40 = 5pt overshoot (warning).
 * Top:  maxY = 624 -> 624 - safeZoneBBoxPt.maxY(621) = 3pt overshoot (warning).
 * Right (maxX=300) and bottom (minY=300) stay inside the safe zone.
 * Neither minX=40 nor maxY=624 comes within EDGE_TOUCH_TOLERANCE_PT of
 * trimBoxPt (9 / 657) -- confirmed by the numbers alone, not touching.
 */
async function buildMultiSideLemWarningFixture() {
  const rect = { x: 40, y: 300, width: 260, height: 324 }; // minX=40, maxX=300, minY=300, maxY=624
  const { bytes } = await buildSingleRectFixture(rect);
  return { bytes, rect };
}

/**
 * GROUP C -- mixed LEM + BLEED on different sides of the same object.
 *
 * Left: minX = 6 -- crosses trim (trimBoxPt.minX=9, overshoot 3pt) but
 * falls 6pt short of the bleed edge (bleedBoxPt.minX=0) -> genuine BLEED
 * violation, and this side DOES touch trim (6 <= 9+1).
 * Top: maxY = 624 -- same as Group B's top side, a 3pt LEM/warning
 * overshoot, NOT touching trim.
 * Right (maxX=106) and bottom (minY=300) stay inside the safe zone.
 */
async function buildMixedLemBleedFixture() {
  const rect = { x: 6, y: 300, width: 100, height: 324 }; // minX=6, maxX=106, minY=300, maxY=624
  const { bytes } = await buildSingleRectFixture(rect);
  return { bytes, rect };
}

module.exports = {
  buildEdgeTouchUntouchedLemFixture,
  buildMultiSideLemWarningFixture,
  buildMixedLemBleedFixture,
};
