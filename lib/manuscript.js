/**
 * Manuscript (interior) PDF inspection — page count and page-size
 * consistency, the inputs the Spine Auto-Calibrator needs from the
 * interior file before it can compute cover dimensions.
 *
 * IMPORTANT CAVEAT: the "trimWidthIn/trimHeightIn" returned here are the
 * PDF's actual MediaBox dimensions, not necessarily the nominal KDP trim
 * size. If the author already added bleed (required for any page with
 * images reaching the edge), the MediaBox is oversized by 0.125"/0.25"
 * versus the nominal trim (e.g. a 6x9 book with bleed measures
 * 6.125 x 9.25). Most author-generated PDFs (Word/Canva) have no distinct
 * TrimBox, so we cannot always tell bleed-included from bleed-excluded
 * from the file alone — the UI must ask the user to confirm/select the
 * intended KDP trim size, using the detected size as a cross-check
 * (see matchKdpTrimSize, TODO) rather than a silent source of truth.
 */

'use strict';

const { PDFDocument } = require('pdf-lib');

/**
 * @param {Uint8Array|ArrayBuffer} pdfBytes
 * @returns {Promise<{
 *   pageCount: number,
 *   trimWidthIn: number,
 *   trimHeightIn: number,
 *   pageSizeConsistent: boolean,
 *   pageSizes: Array<{widthIn: number, heightIn: number}>,
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
    const { width, height } = p.getSize();
    return {
      widthIn: round(width / 72, 4),
      heightIn: round(height / 72, 4),
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
    trimWidthIn: first.widthIn,
    trimHeightIn: first.heightIn,
    pageSizeConsistent,
    pageSizes,
  };
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

module.exports = { inspectManuscript };
