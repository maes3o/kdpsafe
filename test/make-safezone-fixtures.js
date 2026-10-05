'use strict';

/**
 * Fixtures for the Margin/Bleed/LEM detection-only expansion
 * (2026-10-05): systematic coverage of LEM/Trim/Bleed relationships
 * across text/image/path types, rotation, nested q/Q, and clipping --
 * exercising lib/margin.js's classifyViolations(). Nested Form XObjects
 * are covered separately by reusing make-form-xobject-fixture.js's
 * builder (see margin-violations.test.js).
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
  concatTransformationMatrix,
} = require('pdf-lib');
const { matMul, transformRectBBox } = require('../lib/margin');
const { mediaBoxSize, trimBoxPt, safeZoneBBoxPt, bleedBoxPt } = require('./zones');

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
 * One page, seven independent filled rects (document order == results
 * order, since pdf.js's operator list follows content-stream order), each
 * exercising one path-object LEM/Trim/Bleed category -- including the
 * 4-rung boundary ladder requested explicitly: exactly on LEM, minimal
 * overshoot, exactly 0.1in overshoot, and slightly more than 0.1in.
 */
async function buildPathCasesFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage(mediaBoxSize);

  const cases = [
    // (a) Fully inside the LEM safe zone -- no violation anywhere.
    { label: 'safe-inside-lem', rect: { x: safeZoneBBoxPt.minX + 20, y: safeZoneBBoxPt.minY + 20, width: 40, height: 40 } },
    // (b) Exactly on the LEM boundary (left/bottom edges coincide with
    // it) -- within TOLERANCE_PT, so still safe.
    { label: 'exactly-on-lem', rect: { x: safeZoneBBoxPt.minX, y: safeZoneBBoxPt.minY, width: 40, height: 40 } },
    // (c) Minimal real overshoot past LEM: 1pt, above the 0.5pt
    // export-noise tolerance but far below the 7.2pt autofix threshold.
    { label: 'minimal-overshoot-lem', rect: { x: safeZoneBBoxPt.minX - 1, y: safeZoneBBoxPt.minY + 20, width: 40, height: 40 } },
    // (d) Exactly 0.1in (7.2pt) overshoot -- the autofix-threshold
    // boundary itself, inclusive (still 'warning').
    { label: 'exactly-0.1in-overshoot-lem', rect: { x: safeZoneBBoxPt.minX - 7.2, y: safeZoneBBoxPt.minY + 20, width: 40, height: 40 } },
    // (e) Slightly more than 0.1in overshoot -- now 'error'.
    { label: 'over-0.1in-overshoot-lem', rect: { x: safeZoneBBoxPt.minX - 7.5, y: safeZoneBBoxPt.minY + 20, width: 40, height: 40 } },
    // (f) Intentional full bleed: touches the trim edge and runs all the
    // way to the bleed edge -- safe, no violation on that side.
    { label: 'full-bleed-safe', rect: { x: bleedBoxPt.minX, y: safeZoneBBoxPt.minY + 20, width: trimBoxPt.minX - bleedBoxPt.minX + 40, height: 40 } },
    // (g) Partial bleed: crosses the trim edge but falls short of the
    // bleed edge by a real gap -- the classic "almost touches the edge" mistake.
    { label: 'partial-bleed-violation', rect: { x: trimBoxPt.minX - 3, y: safeZoneBBoxPt.minY + 100, width: 40, height: 40 } },
  ];

  for (const c of cases) {
    page.pushOperators(...rectOps(c.rect.x, c.rect.y, c.rect.width, c.rect.height));
  }

  const bytes = await doc.save();
  return { bytes, labels: cases.map((c) => c.label) };
}

/**
 * A 60x60 rect, local corners (-20,-20)..(40,40), rotated 30deg about the
 * origin and then translated near the LEM's bottom-left corner, so its
 * rotated AABB pokes out past the LEM boundary -- tests that
 * classifyViolations works directly off margin.js's existing rotated-AABB
 * approximation (no new geometry introduced here; the expected bbox below
 * is computed with the SAME matMul/transformRectBBox helpers margin.js
 * itself exports and uses, which are already covered by
 * margin-form-xobject.test.js -- used here purely as geometry, not as a
 * test of margin.js operator-list handling).
 */
async function buildRotatedPathFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage(mediaBoxSize);

  const px = safeZoneBBoxPt.minX + 10;
  const py = safeZoneBBoxPt.minY + 10;
  const theta = (30 * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const rotate = [cos, sin, -sin, cos, 0, 0];
  const translate = [1, 0, 0, 1, px, py];

  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...translate),
    concatTransformationMatrix(...rotate),
    setFillingRgbColor(0.2, 0.2, 0.2),
    rectangle(-20, -20, 60, 60),
    fill(),
    popGraphicsState()
  );

  const bytes = await doc.save();
  // Confirmed empirically (not assumed -- see the two-point experiment in
  // this session's notes): successive `cm` concatenations compose as
  // CTM_new = matMul(CTM_old, M_new), and matMul(m1, m2) applied to a
  // point means m2 is applied FIRST (innermost), m1 applied second
  // (outermost): CTM(p) = m1(m2(p)). So concatenating translate first and
  // rotate second gives CTM = matMul(translate, rotate), whose point
  // semantics are translate(rotate(p)) -- rotate the local rect about its
  // own (0,0) origin FIRST, then translate the whole rotated shape to its
  // page position SECOND. (The reverse call order, rotate-then-translate,
  // instead rotates the already-translated shape about the world origin
  // -- a very different and much larger sweep, confirmed by hand while
  // debugging this fixture.)
  const ctm = matMul(translate, rotate);
  const expectedRawBBoxPt = transformRectBBox({ x: -20, y: -20, width: 60, height: 60 }, ctm);
  return { bytes, expectedRawBBoxPt };
}

/**
 * Nested q/Q with two different translations, confirming the CTM stack
 * restores correctly across nesting: one rect drawn inside an inner save
 * scope (outer + inner translate), one drawn after the inner restore but
 * still inside the outer save scope (outer translate only, inner
 * translate must NOT leak).
 */
async function buildNestedSaveRestoreFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage(mediaBoxSize);

  const outerDx = 50;
  const outerDy = 50;
  const innerDx = 20;
  const innerDy = 0;

  page.pushOperators(
    pushGraphicsState(), // outer q
    concatTransformationMatrix(1, 0, 0, 1, outerDx, outerDy),
    pushGraphicsState(), // inner q
    concatTransformationMatrix(1, 0, 0, 1, innerDx, innerDy),
    setFillingRgbColor(0.3, 0.3, 0.3),
    rectangle(0, 0, 10, 10), // drawn at (outerDx+innerDx, outerDy+innerDy)
    fill(),
    popGraphicsState(), // inner Q -- restores to outer-only transform
    setFillingRgbColor(0.6, 0.6, 0.6),
    rectangle(0, 0, 10, 10), // drawn at (outerDx, outerDy) -- inner transform must NOT leak
    fill(),
    popGraphicsState() // outer Q
  );

  const bytes = await doc.save();
  return {
    bytes,
    expectedInnerBBoxPt: { minX: outerDx + innerDx, minY: outerDy + innerDy, maxX: outerDx + innerDx + 10, maxY: outerDy + innerDy + 10 },
    expectedOuterOnlyBBoxPt: { minX: outerDx, minY: outerDy, maxX: outerDx + 10, maxY: outerDy + 10 },
  };
}

/**
 * A rect whose RAW path extends past the LEM boundary (and touches trim)
 * but is clipped to a smaller rect fully inside the safe zone --
 * classifyViolations must be called with visibleBBoxPt (not rawBBoxPt) to
 * come out clean.
 */
async function buildClippedSafeFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage(mediaBoxSize);

  const clipRect = { x: safeZoneBBoxPt.minX + 20, y: safeZoneBBoxPt.minY + 20, width: 40, height: 40 };
  const rawRect = { x: trimBoxPt.minX - 5, y: safeZoneBBoxPt.minY + 20, width: 200, height: 40 };

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
  return { bytes, clipRect, rawRect };
}

/**
 * Three text runs ('Kg', real ascent+descent glyphs), horizontal position
 * fixed safely inside LEM so only the bottom side is ever at stake:
 * inside LEM, crossing into the margin, and crossing all the way past
 * trim into the bleed gap. Text severity rules differ from path/image
 * (any LEM violation on text is 'error', per autofix.js's "text is never
 * auto-corrected") -- this exercises that path specifically.
 */
async function buildTextCasesFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(mediaBoxSize);
  const fontSize = 12;
  const x = safeZoneBBoxPt.minX + 20;

  const cases = [
    { label: 'text-inside-lem', y: safeZoneBBoxPt.minY + 20 },
    { label: 'text-crossing-lem', y: safeZoneBBoxPt.minY - 2 },
    { label: 'text-past-trim', y: trimBoxPt.minY - 2 },
  ];

  for (const c of cases) {
    page.drawText('Kg', { x, y: c.y, size: fontSize, font });
  }

  const bytes = await doc.save();
  return { bytes, labels: cases.map((c) => c.label) };
}

/**
 * A tiny embedded PNG drawn at various positions: normal (safe inside
 * LEM), full-bleed (safe, touches trim and reaches the bleed edge), and
 * partial-bleed (crosses trim but falls short of the bleed edge).
 */
async function buildImageCasesFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage(mediaBoxSize);
  const png = await doc.embedPng(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
  );

  const cases = [
    { label: 'image-safe-inside-lem', opts: { x: safeZoneBBoxPt.minX + 20, y: safeZoneBBoxPt.minY + 20, width: 40, height: 40 } },
    { label: 'image-full-bleed-safe', opts: { x: bleedBoxPt.minX, y: safeZoneBBoxPt.minY + 20, width: trimBoxPt.minX - bleedBoxPt.minX + 60, height: 40 } },
    { label: 'image-partial-bleed-violation', opts: { x: trimBoxPt.minX - 3, y: safeZoneBBoxPt.minY + 100, width: 40, height: 40 } },
  ];

  for (const c of cases) {
    page.drawImage(png, c.opts);
  }

  const bytes = await doc.save();
  return { bytes, labels: cases.map((c) => c.label) };
}

module.exports = {
  buildPathCasesFixture,
  buildRotatedPathFixture,
  buildNestedSaveRestoreFixture,
  buildClippedSafeFixture,
  buildTextCasesFixture,
  buildImageCasesFixture,
};
