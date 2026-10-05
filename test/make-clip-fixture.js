'use strict';
/**
 * Builds a synthetic test PDF: a 6x9in page with a filled rectangle whose
 * RAW path geometry extends into the bleed/margin zone, but which is
 * clipped to a smaller "safe" rectangle before fill. This is exactly the
 * case Gemini flagged: the object's own path bbox is unsafe, but its
 * VISIBLE (clipped) extent is safe, and KDP only cares about the visible
 * extent.
 */
const {
  PDFDocument,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
  setFillingRgbColor,
  fill,
} = require('pdf-lib');

async function buildClipFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([6 * 72, 9 * 72]); // 6x9in, points

  // Safe clip rectangle: 1in..5in x, 1in..8in y (well inside the page)
  const clipRect = { x: 72, y: 72, width: 4 * 72, height: 7 * 72 };

  // The filled rectangle's RAW geometry: starts at 0.5in, extends past the
  // right edge of the page (7in wide on a 6in-wide page) -> unsafe if you
  // only looked at the raw path, safe once you apply the clip.
  const rawRect = { x: 36, y: 72, width: 7 * 72, height: 7 * 72 };

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

  const bytes = await doc.save();
  return { bytes, clipRect, rawRect, pageWidthPt: 6 * 72, pageHeightPt: 9 * 72 };
}

module.exports = { buildClipFixture };
