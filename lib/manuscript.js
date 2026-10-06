/**
 * Manuscript (interior) PDF inspection -- page count and PAGE SIZE.
 *
 * TERMINOLOGY (page-geometry V2 fix): what this module measures is the
 * PAGE SIZE, i.e. the rectangle a viewer/printer shows: CropBox clipped to
 * MediaBox (CropBox defaults to MediaBox), with width/height swapped for
 * /Rotate 90/270. It is NOT the trim size. A PDF's trim is only known when
 * it has an explicit /TrimBox (see lib/pageGeometry.js) or the user states
 * it (userIntent.trimSize). The old `trimWidthIn/trimHeightIn` names for
 * this value were semantically wrong; they remain ONLY as deprecated
 * aliases of pageWidthIn/pageHeightIn for the cover/spine pipeline and must
 * not be shown to users as "trim size".
 */

'use strict';

const { PDFDocument } = require('pdf-lib');

function intersect(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

/**
 * Effective (displayed) size of one pdf-lib page in points: CropBox clipped
 * to MediaBox, then rotation applied.
 */
function effectivePageSizePt(page) {
  const media = page.getMediaBox();
  const crop = page.getCropBox(); // falls back to MediaBox when absent
  const visible = intersect(crop, media);
  const rotation = page.getRotation();
  const angle = rotation ? ((Math.round(rotation.angle) % 360) + 360) % 360 : 0;
  const swap = angle === 90 || angle === 270;
  return { widthPt: swap ? visible.height : visible.width, heightPt: swap ? visible.width : visible.height, rotationDeg: angle };
}

/**
 * @param {Uint8Array|ArrayBuffer} pdfBytes
 * @returns {Promise<{
 *   pageCount: number,
 *   pageWidthIn: number,
 *   pageHeightIn: number,
 *   pageSizeConsistent: boolean,
 *   pageSizes: Array<{widthIn: number, heightIn: number}>,
 *   trimWidthIn: number,   // DEPRECATED alias of pageWidthIn
 *   trimHeightIn: number,  // DEPRECATED alias of pageHeightIn
 * }>}
 */
async function inspectManuscript(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const pageCount = pages.length;

  if (pageCount === 0) {
    throw new Error('Manuscript PDF has no pages');
  }

  // PDF user units are points (1/72 inch).
  const pageSizes = pages.map((p) => {
    const { widthPt, heightPt } = effectivePageSizePt(p);
    return {
      widthIn: round(widthPt / 72, 4),
      heightIn: round(heightPt / 72, 4),
    };
  });

  const first = pageSizes[0];
  const TOLERANCE_IN = 0.01; // guard against float noise, not a real size difference
  const pageSizeConsistent = pageSizes.every(
    (s) =>
      Math.abs(s.widthIn - first.widthIn) <= TOLERANCE_IN &&
      Math.abs(s.heightIn - first.heightIn) <= TOLERANCE_IN
  );

  return {
    pageCount,
    pageWidthIn: first.widthIn,
    pageHeightIn: first.heightIn,
    pageSizeConsistent,
    pageSizes,
    // DEPRECATED aliases (cover/spine pipeline only) -- NOT a trim size.
    trimWidthIn: first.widthIn,
    trimHeightIn: first.heightIn,
  };
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

module.exports = { inspectManuscript, effectivePageSizePt };
