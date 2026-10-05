'use strict';

const assert = require('node:assert/strict');
const { planAutofix, THRESHOLD_PT } = require('../lib/autofix');

function main() {
  const pageWidthPt = 6 * 72;
  const pageHeightPt = 9 * 72;
  const pageBoxPt = { minX: 0, minY: 0, maxX: pageWidthPt, maxY: pageHeightPt };
  const bleedPt = 0.125 * 72;
  const bleedZoneBBoxPt = {
    minX: -bleedPt,
    minY: -bleedPt,
    maxX: pageWidthPt + bleedPt,
    maxY: pageHeightPt + bleedPt,
  };
  const lemPt = 0.25 * 72;
  const safeZone = { minX: lemPt, minY: lemPt, maxX: pageWidthPt - lemPt, maxY: pageHeightPt - lemPt };

  // Gemini's point: any object touching a page edge (full-width background
  // OR a design element bleeding off only ONE side) must never be routed
  // through ordinary LEM shift-autofix — shifting it to satisfy the LEM
  // check would pull it away from an edge it's *supposed* to touch,
  // opening a print gap there. With this project's actual numbers
  // (LEM 0.25in > autofix threshold 0.1in), the old magnitude check
  // already happened to block most such shifts too — but only by
  // coincidence of those two constants, not because the code understood
  // what it was looking at. The bleed-aware check below makes that
  // protection explicit and correct instead of incidental, and gives a
  // meaningful reason instead of a generic "too big to fix".

  // 1) A background bleeding off only the LEFT edge, correctly reaching the
  //    bleed boundary, with its right edge sitting safely in the interior
  //    (not touching the right page edge at all) -> must be reported safe,
  //    even though it is "outside LEM" on the left by design.
  {
    const leftBleedingElement = {
      type: 'image',
      visibleBBoxPt: { minX: -bleedPt, minY: 100, maxX: 250, maxY: 300 },
    };
    const plan = planAutofix(leftBleedingElement, safeZone, { pageBoxPt, bleedZoneBBoxPt });
    console.log('Correct single-edge bleed element:', plan);
    assert.equal(plan.status, 'safe', 'an element correctly bleeding off one edge must be safe, not flagged for an LEM "violation" that is by design');
  }

  // 2) The same kind of element, but 0.05in SHORT of the bleed boundary on
  //    that same left edge -> must be flagged, and must NEVER receive a
  //    shift (shifting right would be nonsensical here: there is nothing
  //    to shift toward, the fix is to extend the element, not move it).
  {
    const shortLeftBleed = {
      type: 'image',
      visibleBBoxPt: { minX: -bleedPt + 3.6, minY: 100, maxX: 250, maxY: 300 },
    };
    const plan = planAutofix(shortLeftBleed, safeZone, { pageBoxPt, bleedZoneBBoxPt });
    console.log('Short single-edge bleed element:', plan);
    assert.equal(plan.status, 'manual_review', 'a bleed element short of the bleed boundary must go to manual review');
    assert.ok(!plan.shift, 'must never receive a shift — a shift cannot fix insufficient bleed coverage');
    assert.match(plan.reason, /зліва/, 'reason should point at the left-edge gap');
  }

  // 3) Without a bleed zone supplied at all, an edge-touching object must
  //    still default to manual_review rather than guessing.
  {
    const leftBleedingElement = {
      type: 'image',
      visibleBBoxPt: { minX: -bleedPt, minY: 100, maxX: 250, maxY: 300 },
    };
    const plan = planAutofix(leftBleedingElement, safeZone, { pageBoxPt }); // no bleedZoneBBoxPt
    console.log('Edge-touching element, no bleed zone given:', plan);
    assert.equal(plan.status, 'manual_review', 'missing bleed-zone info must default to manual review, never a guessed shift');
  }

  // 4) Control: an ordinary small foreground graphic that does NOT touch
  //    any page edge must still go through normal shift-autofix as before.
  {
    const smallGraphic = {
      type: 'path',
      visibleBBoxPt: { minX: 14.4, minY: 100, maxX: 200, maxY: 150 }, // 3.6pt short of LEM, nowhere near a page edge
    };
    const plan = planAutofix(smallGraphic, safeZone, { pageBoxPt, bleedZoneBBoxPt });
    console.log('Ordinary small foreground graphic:', plan);
    assert.equal(plan.status, 'autofix', 'a normal small interior violation, unrelated to any page edge, must still autofix');
  }

  console.log(`\n(threshold in use: ${THRESHOLD_PT}pt)`);
  console.log('All autofix-bleed-guard.test.js tests passed.');
}

main();
