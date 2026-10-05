'use strict';

/**
 * Fixtures for the PAGE-BOX + PAGE-ROTATION EMPIRICAL VALIDATION checkpoint
 * (2026-10-05) -- requested explicitly to replace assumption with
 * observation before any zones-builder design is finalized. Two gaps were
 * identified by the preceding ZONES CONTRACT AUDIT:
 *
 *   (A) no fixture in the repo had ever set a real PDF-dictionary
 *       /TrimBox or /BleedBox (every existing fixture only sets a
 *       MediaBox, via doc.addPage([w,h])) -- so it was unverified whether
 *       pdf-lib can even write/read those boxes, what shape/units they
 *       come back in, and whether lib/margin.js's analyzePageObjects()
 *       reacts to them at all.
 *
 *   (B) no fixture had ever set a page-level /Rotate -- so it was
 *       unverified whether analyzePageObjects()'s object coordinates
 *       change under rotation, or stay in raw (unrotated) PDF user-space.
 *
 * Both builders below are deliberately minimal (single page, one or a few
 * plain filled rects) so every returned number is traceable by hand. This
 * file does NOT touch lib/margin.js, lib/autofix.js, lib/marginPolicy.js,
 * or test/zones.js, and does not wire its fixtures into any existing
 * reconciliation suite -- it exists purely to let
 * test/page-geometry-contract.test.js observe real pdf-lib/pdfjs-dist
 * behavior.
 */

const { PDFDocument, degrees, pushGraphicsState, popGraphicsState, setFillingRgbColor, rectangle, fill } = require('pdf-lib');

function rectOps(x, y, w, h) {
  return [
    pushGraphicsState(),
    setFillingRgbColor(0.2, 0.2, 0.2),
    rectangle(x, y, w, h),
    fill(),
    popGraphicsState(),
  ];
}

/**
 * MediaBox 0..500 x 0..700 (deliberately DIFFERENT from test/zones.js's
 * 450x666, so this fixture's real PDF-dictionary boxes can never be
 * mistaken for -- or silently match -- the synthetic zones.js numbers that
 * classifyViolations() is actually tested against).
 *
 * Explicit BleedBox: inset 10pt from MediaBox on every side -> 10..490 x
 * 10..690.
 * Explicit TrimBox: inset a further 20pt from BleedBox on every side ->
 * 30..470 x 30..670.
 *
 * Three known rects, each placed in one of the three resulting bands so
 * the four boundaries (MediaBox edge, BleedBox, TrimBox, and the object
 * itself) are all distinguishable by inspection:
 *   - 'inside-trim': fully inside the TrimBox interior.
 *   - 'bleed-to-trim-band': between TrimBox and BleedBox (inside bleed,
 *     outside trim -- the normal "intentional bleed" band).
 *   - 'media-to-bleed-band': between BleedBox and MediaBox (outside the
 *     declared bleed box, but still inside the physical page/MediaBox).
 */
async function buildExplicitPageBoxFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([500, 700]);

  const mediaBoxPt = { minX: 0, minY: 0, maxX: 500, maxY: 700 };
  const bleedBoxPt = { minX: 10, minY: 10, maxX: 490, maxY: 690 };
  const trimBoxPt = { minX: 30, minY: 30, maxX: 470, maxY: 670 };

  page.setMediaBox(mediaBoxPt.minX, mediaBoxPt.minY, mediaBoxPt.maxX - mediaBoxPt.minX, mediaBoxPt.maxY - mediaBoxPt.minY);
  page.setBleedBox(bleedBoxPt.minX, bleedBoxPt.minY, bleedBoxPt.maxX - bleedBoxPt.minX, bleedBoxPt.maxY - bleedBoxPt.minY);
  page.setTrimBox(trimBoxPt.minX, trimBoxPt.minY, trimBoxPt.maxX - trimBoxPt.minX, trimBoxPt.maxY - trimBoxPt.minY);

  const rects = {
    'inside-trim': { x: 100, y: 100, width: 50, height: 50 }, // 100..150 x 100..150, well inside trimBoxPt
    'bleed-to-trim-band': { x: 15, y: 100, width: 10, height: 50 }, // 15..25 x 100..150, inside bleed (10..490) but outside trim (30..470)
    'media-to-bleed-band': { x: 2, y: 100, width: 5, height: 50 }, // 2..7 x 100..150, outside bleed (10..490) but still inside media (0..500)
  };

  for (const key of Object.keys(rects)) {
    const r = rects[key];
    page.pushOperators(...rectOps(r.x, r.y, r.width, r.height));
  }

  const bytes = await doc.save();
  return { bytes, mediaBoxPt, bleedBoxPt, trimBoxPt, rects };
}

/**
 * A page whose MediaBox is deliberately non-square (300 wide x 500 tall)
 * so that a 90/270-degree rotation's effect on *reported dimensions* is
 * unambiguous (a square page would hide a width/height swap), with page
 * -level /Rotate set to the given angle (0, 90, 180, or 270) and one
 * rect at a fixed, asymmetric raw PDF-space position (near the
 * bottom-left corner, closer to the left edge than the bottom edge, so a
 * rotation that maps left<->bottom is also visible by inspection):
 * x=20..70 (closer to left), y=40..90 (a bit further from bottom).
 */
async function buildRotatedPageFixture(angleDeg) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 500]);
  if (angleDeg) {
    page.setRotation(degrees(angleDeg));
  }

  const rect = { x: 20, y: 40, width: 50, height: 50 }; // 20..70 x 40..90 in raw PDF user-space

  page.pushOperators(...rectOps(rect.x, rect.y, rect.width, rect.height));

  const bytes = await doc.save();
  return { bytes, angleDeg, mediaBoxSize: [300, 500], rect };
}

module.exports = {
  buildExplicitPageBoxFixture,
  buildRotatedPageFixture,
};
