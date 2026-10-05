'use strict';

/**
 * Form XObject fixture for the Margin/Bleed/LEM module's new
 * paintFormXObjectBegin/End handling (2026-10-04 architecture-inventory
 * finding, confirmed empirically before this fixture was written -- see
 * margin.js's comment at that case for the full explanation).
 *
 * Built via pdf-lib's supported embedPdf()/drawPage() path (NOT the raw
 * low-level context.formXObject() API, which produced a malformed
 * Form XObject pdf.js refused to read as "XObject should be a stream" in
 * manual testing) -- embedPdf() embeds a whole source page as a real,
 * well-formed Form XObject with its own BBox and Matrix.
 */

const { PDFDocument, rgb, degrees } = require('pdf-lib');

/**
 * Transform all 4 corners of a rect by drawPage's placement (translate,
 * then rotate, then uniform scale -- matching pdf-lib's own
 * translate->rotate->scale->skew cm sequence in operations.js' drawPage(),
 * with skew unused here) and return the AXIS-ALIGNED bounding box of the
 * 4 transformed corners. This is deliberately an AABB-of-rotated-corners,
 * NOT the tight rotated rectangle itself -- margin.js only ever tracks
 * axis-aligned bboxes (see its file-header scope note), so this is the
 * correct "ground truth" to assert against, and doubles as the explicit
 * documentation of that approximation's boundary for rotated placements.
 */
function transformRectAABB(rect, placement) {
  const { x: px, y: py, scale = 1, rotateDegrees: deg = 0 } = placement;
  const theta = (deg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ].map(([x, y]) => {
    const sx = x * scale;
    const sy = y * scale;
    const rx = sx * cos - sy * sin;
    const ry = sx * sin + sy * cos;
    return { x: px + rx, y: py + ry };
  });
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/**
 * @param {Object} opts
 * @param {{x:number,y:number,width:number,height:number}} opts.formBBox
 *   The embedded page's own page box (becomes the Form XObject's /BBox).
 * @param {{x:number,y:number,width:number,height:number}} opts.rectInForm
 *   A rectangle drawn on the source page, in the SOURCE page's own
 *   coordinate space -- deliberately allowed to extend outside formBBox
 *   to exercise the Form's implicit BBox clip.
 * @param {{x:number,y:number,scale:number,rotateDegrees?:number}} opts.placement
 *   Where/how the Form is placed on the main page (drawPage's x/y, a
 *   uniform xScale/yScale, and an optional rotate).
 */
async function buildFormXObjectFixture({
  formBBox = { x: 0, y: 0, width: 50, height: 50 },
  rectInForm = { x: -20, y: -20, width: 100, height: 100 },
  placement = { x: 100, y: 100, scale: 2, rotateDegrees: 0 },
  mainPageSize = [432, 648],
} = {}) {
  const srcDoc = await PDFDocument.create();
  const srcPage = srcDoc.addPage([formBBox.width, formBBox.height]);
  srcPage.drawRectangle({
    x: rectInForm.x,
    y: rectInForm.y,
    width: rectInForm.width,
    height: rectInForm.height,
    color: rgb(0.8, 0.1, 0.1),
  });
  const srcBytes = await srcDoc.save();

  const mainDoc = await PDFDocument.create();
  const mainPage = mainDoc.addPage(mainPageSize);
  const [embedded] = await mainDoc.embedPdf(srcBytes);
  mainPage.drawPage(embedded, {
    x: placement.x,
    y: placement.y,
    xScale: placement.scale,
    yScale: placement.scale,
    rotate: degrees(placement.rotateDegrees || 0),
  });

  const bytes = await mainDoc.save();

  // Pre-computed expected geometry, in PAGE space, for the test to assert
  // against -- independent of margin.js's own code:
  //   expectedRawBBoxPt     = AABB of rectInForm's 4 corners, transformed
  //                           by placement (NOT clipped)
  //   expectedVisibleBBoxPt = expectedRawBBoxPt intersected with the AABB
  //                           of formBBox's 4 corners, transformed the
  //                           same way (what the Form's implicit BBox
  //                           clip limits visibility to)
  const expectedRawBBoxPt = transformRectAABB(rectInForm, placement);
  const transformedBBoxAABB = transformRectAABB(formBBox, placement);
  const expectedVisibleBBoxPt = {
    minX: Math.max(transformedBBoxAABB.minX, expectedRawBBoxPt.minX),
    minY: Math.max(transformedBBoxAABB.minY, expectedRawBBoxPt.minY),
    maxX: Math.min(transformedBBoxAABB.maxX, expectedRawBBoxPt.maxX),
    maxY: Math.min(transformedBBoxAABB.maxY, expectedRawBBoxPt.maxY),
  };

  return { bytes, expectedRawBBoxPt, expectedVisibleBBoxPt };
}

module.exports = { buildFormXObjectFixture, transformRectAABB };
