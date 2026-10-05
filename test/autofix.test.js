'use strict';

const assert = require('node:assert/strict');
const { planAutofix, THRESHOLD_PT } = require('../lib/autofix');

function main() {
  const safeZone = { minX: 18, minY: 18, maxX: 414, maxY: 630 }; // 0.25in LEM on a 6x9in page

  // 1) Small graphics violation (0.05in = 3.6pt past the zone) -> autofix.
  {
    const obj = { type: 'path', visibleBBoxPt: { minX: 14.4, minY: 20, maxX: 410, maxY: 600 } };
    const plan = planAutofix(obj, safeZone);
    console.log('Small graphics violation ->', plan);
    assert.equal(plan.status, 'autofix', 'small graphics overflow should autofix');
    assert.ok(Math.abs(plan.shift.dx - 3.6) < 0.01, 'shift should exactly close the 3.6pt gap');
    assert.equal(plan.fixedBBoxPt.minX, safeZone.minX, 'fixed bbox should sit exactly on the zone edge');
  }

  // 2) Large graphics violation (0.3in = 21.6pt, over the 0.1in threshold) -> manual review.
  {
    // Width (380pt) comfortably fits the 396pt-wide safe zone — this
    // isolates the "violation too large for autofix" path from the
    // separate "object bigger than the zone" path tested below.
    const obj = { type: 'image', visibleBBoxPt: { minX: -3.6, minY: 20, maxX: 376.4, maxY: 600 } };
    const plan = planAutofix(obj, safeZone);
    console.log('Large graphics violation ->', plan);
    assert.equal(plan.status, 'manual_review', 'large graphics overflow must NOT be auto-corrected');
    assert.ok(!plan.shift, 'no shift should be returned for manual_review');
    assert.match(plan.reason, /перевищує порог/, 'reason should cite the threshold, not an oversized object');
  }

  // 3) Text violation, even a TINY one (0.01in) -> always manual review, never shifted.
  {
    const obj = { type: 'text', visibleBBoxPt: { minX: 17.3, minY: 20, maxX: 410, maxY: 600 } };
    const plan = planAutofix(obj, safeZone);
    console.log('Tiny text violation ->', plan);
    assert.equal(plan.status, 'manual_review', 'text must always go to manual review');
    assert.ok(!plan.shift, 'text must never be auto-shifted, regardless of magnitude');
  }

  // 4) Object already safe -> no action.
  {
    const obj = { type: 'path', visibleBBoxPt: { minX: 100, minY: 100, maxX: 200, maxY: 200 } };
    const plan = planAutofix(obj, safeZone);
    assert.equal(plan.status, 'safe');
  }

  // 5) Object wider than the whole safe zone -> can't be shift-fixed, manual review.
  {
    const obj = { type: 'path', visibleBBoxPt: { minX: -50, minY: 20, maxX: 500, maxY: 600 } };
    const plan = planAutofix(obj, safeZone);
    console.log('Oversized object ->', plan);
    assert.equal(plan.status, 'manual_review');
    assert.match(plan.reason, /більший за безпечну зону/);
  }

  console.log(`\nThreshold in use: ${THRESHOLD_PT}pt`);
  console.log('All autofix.test.js tests passed.');
}

main();
