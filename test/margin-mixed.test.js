'use strict';

const assert = require('node:assert/strict');
const { buildMixedFixture } = require('./make-mixed-fixture');
const { analyzePageObjects, isWithinSafeZone } = require('../lib/margin');

async function main() {
  const { bytes, pageWidthPt, pageHeightPt } = await buildMixedFixture();
  const results = await analyzePageObjects(bytes, 0);

  const byType = { path: [], image: [], text: [] };
  for (const r of results) byType[r.type].push(r);

  console.log(`Detected: ${byType.path.length} path, ${byType.image.length} image, ${byType.text.length} text object(s)`);

  assert.equal(byType.path.length, 1, 'expected one clipped vector path');
  assert.equal(byType.image.length, 1, 'expected one image');
  assert.equal(byType.text.length, 1, 'expected one text run');

  // LEM zone used for this check: 0.25in inside the trim on every side.
  const lemPt = 0.25 * 72;
  const safeZone = { minX: lemPt, minY: lemPt, maxX: pageWidthPt - lemPt, maxY: pageHeightPt - lemPt };
  // Bleed zone: page extended 0.125in on every side (what's allowed to bleed off).
  const bleedZone = { minX: -0.125 * 72, minY: -0.125 * 72, maxX: pageWidthPt + 0.125 * 72, maxY: pageHeightPt + 0.125 * 72 };

  const [pathObj] = byType.path;
  const [imageObj] = byType.image;
  const [textObj] = byType.text;

  console.log('Clipped path visible bbox:', pathObj.visibleBBoxPt);
  console.log('Image visible bbox:', imageObj.visibleBBoxPt);
  console.log('Text visible bbox:', textObj.visibleBBoxPt, '(approximate:', textObj.approximate, ')');

  // 1) The clipped vector path's visible extent must stay inside the page
  //    (clip correctly suppressed the raw overflow) and well inside LEM.
  assert.ok(isWithinSafeZone(pathObj.visibleBBoxPt, safeZone), 'clipped vector rect should be within the LEM safe zone');

  // 2) The background image intentionally bleeds off the page edges —
  //    that's expected and safe for a bleed background, so it should be
  //    within the (generous) bleed zone even though it is NOT within LEM.
  assert.ok(isWithinSafeZone(imageObj.visibleBBoxPt, bleedZone), 'background image should be within the bleed allowance');
  assert.ok(!isWithinSafeZone(imageObj.visibleBBoxPt, safeZone), 'sanity: the bleeding image should NOT pass the stricter LEM check');

  // 3) The text sits inside the LEM margin by construction (0.05in from
  //    the trim edge, LEM requires 0.25in) — it must be flagged unsafe.
  //    This is the case that must go to manual review, never autofix.
  assert.ok(!isWithinSafeZone(textObj.visibleBBoxPt, safeZone), 'text 0.05in from the trim edge should be flagged as a LEM violation');

  console.log('\nAll margin-mixed.test.js (text + image + clipped-path) tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
