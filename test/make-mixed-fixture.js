'use strict';
/**
 * A "problematic" cover-like fixture mixing all three object types the
 * Margin/Bleed/LEM module must see through a clip mask correctly:
 * a clipped vector rectangle, an unclipped image bleeding off the page
 * edge (expected/safe for backgrounds), and text sitting dangerously
 * close to the trim edge (expected/unsafe — should NOT be auto-fixed,
 * only flagged, per the agreed rule).
 */
const {
  PDFDocument,
  StandardFonts,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
  setFillingRgbColor,
  fill,
} = require('pdf-lib');

async function buildMixedFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([6 * 72, 9 * 72]);

  // 1) Clipped vector rect (same pattern as the clip fixture).
  const clipRect = { x: 72, y: 300, width: 4 * 72, height: 2 * 72 };
  const rawRect = { x: 36, y: 300, width: 7 * 72, height: 2 * 72 };
  page.pushOperators(
    pushGraphicsState(),
    rectangle(clipRect.x, clipRect.y, clipRect.width, clipRect.height),
    clip(),
    endPath(),
    setFillingRgbColor(0.8, 0.1, 0.1),
    rectangle(rawRect.x, rawRect.y, rawRect.width, rawRect.height),
    fill(),
    popGraphicsState()
  );

  // 2) Background image bleeding off the right/bottom edges — safe for a
  // background, since KDP expects bleed content to run to the trimmed edge.
  const png = await doc.embedPng(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
  );
  // Bleed exactly to the standard 0.125in allowance on the left/right/bottom
  // edges — safe for a background, not an arbitrary overflow.
  page.drawImage(png, { x: -0.125 * 72, y: -0.125 * 72, width: 6 * 72 + 0.25 * 72, height: 3 * 72 });

  // 3) Text positioned just 0.05in from the trim edge — inside the LEM
  // zone (0.25in), should be flagged, never silently moved.
  page.drawText('Too close to the edge', { x: 6 * 72 - 3.6 * 72, y: 0.05 * 72, size: 12, font });

  const bytes = await doc.save();
  return { bytes, clipRect, rawRect, pageWidthPt: 6 * 72, pageHeightPt: 9 * 72 };
}

module.exports = { buildMixedFixture };
