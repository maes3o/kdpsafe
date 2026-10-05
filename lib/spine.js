/**
 * KDP Spine & Cover Geometry
 *
 * Formulas from Amazon KDP's published paperback/hardcover cover
 * specification. Values confirmed against Gemini's independent
 * market-validation report (2026-10-04) in addition to KDP's own docs.
 *
 * Bulk factors (inches of spine width per page):
 *   white            0.002252"
 *   cream            0.0025"
 *   standardColor    0.002252"
 *   premiumColor     0.002347"
 *
 * Hardcover (case laminate) adds a fixed 0.189" (4.8mm) to the
 * calculated spine width for the board turn-in.
 *
 * Spine text is only permitted by KDP from 79-80 pages up (sources
 * vary by ±1pp) — below that the spine is too narrow to reliably
 * center type. We use 80 as the conservative cutoff.
 */

'use strict';

const BULK_FACTOR_IN = Object.freeze({
  white: 0.002252,
  cream: 0.0025,
  standardColor: 0.002252,
  premiumColor: 0.002347,
});

const HARDCOVER_ADDITION_IN = 0.189; // 4.8mm
const MIN_PAGES_FOR_SPINE_TEXT = 80;
const BLEED_IN = 0.125; // KDP standard bleed, all four edges where used

const IN_TO_MM = 25.4;

function inToMm(inches) {
  return inches * IN_TO_MM;
}

/**
 * @param {Object} params
 * @param {number} params.pageCount - total interior page count (from manuscript PDF)
 * @param {'white'|'cream'|'standardColor'|'premiumColor'} params.paperType
 * @param {'paperback'|'hardcover'} [params.binding='paperback']
 * @returns {{
 *   spineWidthIn: number,
 *   spineWidthMm: number,
 *   spineTextAllowed: boolean,
 *   paperType: string,
 *   binding: string,
 *   pageCount: number,
 * }}
 */
function calculateSpineWidth({ pageCount, paperType, binding = 'paperback' }) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error(`pageCount must be a positive integer, got ${pageCount}`);
  }
  const bulkFactor = BULK_FACTOR_IN[paperType];
  if (bulkFactor === undefined) {
    throw new Error(
      `Unknown paperType "${paperType}". Expected one of: ${Object.keys(BULK_FACTOR_IN).join(', ')}`
    );
  }
  if (binding !== 'paperback' && binding !== 'hardcover') {
    throw new Error(`binding must be "paperback" or "hardcover", got "${binding}"`);
  }

  let spineWidthIn = pageCount * bulkFactor;
  if (binding === 'hardcover') {
    spineWidthIn += HARDCOVER_ADDITION_IN;
  }

  return {
    spineWidthIn: round(spineWidthIn, 4),
    spineWidthMm: round(inToMm(spineWidthIn), 2),
    spineTextAllowed: pageCount >= MIN_PAGES_FOR_SPINE_TEXT,
    paperType,
    binding,
    pageCount,
  };
}

/**
 * Full wraparound cover dimensions (front + spine + back), with bleed.
 * Standard KDP full-wrap formula:
 *   totalWidth  = bleed + backTrimWidth + spineWidth + frontTrimWidth + bleed
 *   totalHeight = bleed + trimHeight + bleed
 *
 * @param {Object} params
 * @param {number} params.trimWidthIn - single-page trim width (e.g. 6 for 6x9)
 * @param {number} params.trimHeightIn - single-page trim height (e.g. 9 for 6x9)
 * @param {number} params.spineWidthIn - from calculateSpineWidth()
 * @param {boolean} [params.includeBleed=true]
 * @returns {{
 *   totalWidthIn: number, totalHeightIn: number,
 *   totalWidthMm: number, totalHeightMm: number,
 *   frontPanelXIn: number, spinePanelXIn: number, backPanelXIn: number,
 *   bleedIn: number,
 * }}
 */
function calculateCoverDimensions({
  trimWidthIn,
  trimHeightIn,
  spineWidthIn,
  includeBleed = true,
}) {
  if (trimWidthIn <= 0 || trimHeightIn <= 0) {
    throw new Error('trimWidthIn and trimHeightIn must be positive');
  }
  if (spineWidthIn < 0) {
    throw new Error('spineWidthIn must be >= 0');
  }

  const bleed = includeBleed ? BLEED_IN : 0;

  const totalWidthIn = round(bleed + trimWidthIn + spineWidthIn + trimWidthIn + bleed, 4);
  const totalHeightIn = round(trimHeightIn + 2 * bleed, 4);

  // Panel X-offsets from the left edge of the full cover artwork,
  // useful for drawing guides / the Spine Auto-Calibrator overlay grid.
  const backPanelXIn = bleed;
  const spinePanelXIn = round(backPanelXIn + trimWidthIn, 4);
  const frontPanelXIn = round(spinePanelXIn + spineWidthIn, 4);

  return {
    totalWidthIn,
    totalHeightIn,
    totalWidthMm: round(inToMm(totalWidthIn), 2),
    totalHeightMm: round(inToMm(totalHeightIn), 2),
    backPanelXIn: round(backPanelXIn, 4),
    spinePanelXIn,
    frontPanelXIn,
    bleedIn: bleed,
  };
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

module.exports = {
  calculateSpineWidth,
  calculateCoverDimensions,
  BULK_FACTOR_IN,
  HARDCOVER_ADDITION_IN,
  MIN_PAGES_FOR_SPINE_TEXT,
  BLEED_IN,
};
