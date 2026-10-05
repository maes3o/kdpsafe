'use strict';

const assert = require('node:assert/strict');
const { PDFDocument, pushGraphicsState, popGraphicsState, rectangle, setLineWidth, stroke, setStrokingRgbColor } = require('pdf-lib');
const { analyzePageObjects, isWithinSafeZone } = require('../lib/margin');

async function main() {
  const pageWidthPt = 6 * 72;
  const pageHeightPt = 9 * 72;
  const lineWidth = 20; // thick decorative border, 20pt

  const doc = await PDFDocument.create();
  const page = doc.addPage([pageWidthPt, pageHeightPt]);

  // A decorative border rectangle whose PATH sits exactly on the LEM
  // boundary (0.25in inside trim), so it passes a naive geometry-only
  // check — but its 20pt-wide stroke reaches 10pt further out on every
  // side, which crosses into the unsafe zone and must be caught.
  const lemPt = 0.25 * 72; // 18pt
  const x = lemPt;
  const y = lemPt;
  const w = pageWidthPt - 2 * lemPt;
  const h = pageHeightPt - 2 * lemPt;

  page.pushOperators(
    pushGraphicsState(),
    setStrokingRgbColor(0, 0, 0),
    setLineWidth(lineWidth),
    rectangle(x, y, w, h),
    stroke(),
    popGraphicsState()
  );

  const bytes = await doc.save();
  const results = await analyzePageObjects(bytes, 0);

  assert.equal(results.length, 1, 'expected one stroked path');
  const [{ rawBBoxPt, visibleBBoxPt, stroked }] = results;

  console.log('Stroked border bbox (with half-linewidth padding):', visibleBBoxPt);
  assert.equal(stroked, true, 'should be detected as a stroke operation');

  // Padding applied should be ~10pt (half of 20pt line width) on every side.
  assert.ok(Math.abs(visibleBBoxPt.minX - (x - lineWidth / 2)) < 0.5, 'minX padded by half line width');
  assert.ok(Math.abs(visibleBBoxPt.minY - (y - lineWidth / 2)) < 0.5, 'minY padded by half line width');
  assert.ok(Math.abs(visibleBBoxPt.maxX - (x + w + lineWidth / 2)) < 0.5, 'maxX padded by half line width');
  assert.ok(Math.abs(visibleBBoxPt.maxY - (y + h + lineWidth / 2)) < 0.5, 'maxY padded by half line width');

  const safeZone = { minX: lemPt, minY: lemPt, maxX: pageWidthPt - lemPt, maxY: pageHeightPt - lemPt };

  // The bare PATH sits exactly on the LEM line (within tolerance) — a
  // geometry-only check would wrongly call this safe.
  assert.ok(
    Math.abs(x - safeZone.minX) < 0.01 && Math.abs(x + w - safeZone.maxX) < 0.01,
    'sanity: bare path geometry sits exactly on the LEM boundary'
  );

  // With stroke-width padding applied, the VISIBLE extent must be flagged unsafe.
  assert.ok(!isWithinSafeZone(visibleBBoxPt, safeZone), 'thick stroke must be flagged unsafe even though its bare path sits on the LEM line');

  console.log('\nAll margin-stroke.test.js tests passed.');
  console.log('Confirmed: stroke width is now accounted for — a thick border whose geometry sits on the LEM line is correctly flagged unsafe.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
