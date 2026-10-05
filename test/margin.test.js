'use strict';

const assert = require('node:assert/strict');
const { buildClipFixture } = require('./make-clip-fixture');
const { analyzePageObjects } = require('../lib/margin');

async function main() {
  const { bytes, clipRect, rawRect, pageHeightPt } = await buildClipFixture();
  const results = await analyzePageObjects(bytes, 0);

  assert.equal(results.length, 1, 'expected exactly one fill op');
  const [{ rawBBoxPt, visibleBBoxPt }] = results;

  console.log('Raw (unclipped) bbox:', rawBBoxPt);
  console.log('Visible (clipped) bbox:', visibleBBoxPt);
  console.log('Clip rect (pdf-lib input, bottom-left origin):', clipRect);
  console.log('Raw rect (pdf-lib input, bottom-left origin):', rawRect);

  // 1) The RAW bbox must genuinely exceed the page — proves the fixture
  //    is actually testing something ("unsafe if you trusted the raw path").
  assert.ok(rawBBoxPt.maxX > 6 * 72, 'sanity: raw rect should extend past the 6in page width');

  // 2) The VISIBLE bbox, after clip intersection, must match the clip
  //    rectangle's extent exactly (since the raw rect fully covers it) —
  //    this is the core claim: visible extent, not raw path, decides safety.
  const expectedClipBBoxPt = {
    minX: clipRect.x,
    minY: clipRect.y,
    maxX: clipRect.x + clipRect.width,
    maxY: clipRect.y + clipRect.height,
  };

  assert.ok(Math.abs(visibleBBoxPt.minX - expectedClipBBoxPt.minX) < 0.5, 'visible minX ~= clip minX');
  assert.ok(Math.abs(visibleBBoxPt.maxX - expectedClipBBoxPt.maxX) < 0.5, 'visible maxX ~= clip maxX');
  assert.ok(Math.abs(visibleBBoxPt.minY - expectedClipBBoxPt.minY) < 0.5, 'visible minY ~= clip minY');
  assert.ok(Math.abs(visibleBBoxPt.maxY - expectedClipBBoxPt.maxY) < 0.5, 'visible maxY ~= clip maxY');

  // 3) The visible bbox must NOT exceed the page — proving we correctly
  //    avoid flagging this as a bleed/margin violation.
  assert.ok(visibleBBoxPt.maxX <= 6 * 72 + 0.01, 'visible bbox must stay within the 6in page width');

  console.log('\nAll margin.js (clipping-path prototype) tests passed.');
  console.log('Confirmed: an object whose raw path exceeds the page is NOT flagged unsafe once its clip restricts it to the visible safe area.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
