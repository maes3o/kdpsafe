'use strict';

/**
 * Effective-DPI-after-scale estimator (A4, smart-fix-engine-gap-closure.md
 * §F) — replaces a blanket "never scale up" rule with a graduated, numeric
 * one. Pure, read-only arithmetic; no PDF I/O here.
 *
 * IMPORTANT SCOPE NOTE for Phase 2: every strategy actually registered
 * this phase (PROPORTIONAL_SCALE, SCALE_PLUS_PADDING) is shrink-only by
 * construction — see strategies/proportionalScale.js's own header for the
 * proof that their scaleFactor is always <= 1 given how they're detected.
 * Shrinking an image only ever INCREASES effective DPI, never decreases
 * it, so the upscale guard below is never actually reachable through the
 * current registered strategies' own detect() logic. It is implemented
 * and unit-tested anyway, directly, as a safety primitive for any future
 * enlarge-direction strategy (Phase 3+) to reuse — "safety over coverage"
 * means the guard exists and is proven correct BEFORE anything needs it,
 * not added later under pressure once something does.
 */

// KDP's own published guidance recommends >=300 DPI for photos. Flagged
// here exactly as smart-fix-engine-gap-closure.md §F flagged it: this
// specific number should be reconfirmed against KDP's current published
// guidance before being treated as authoritative; it is used as the
// explicit, cited number from that report, not newly invented.
const MIN_SAFE_DPI = 300;

/**
 * @param {{ intrinsicPixelWidth: number, intrinsicPixelHeight: number, placedWidthPt: number, placedHeightPt: number }} image
 * @param {number} scaleFactor  >1 means enlarging
 * @returns {number} effective DPI after the scale, on the binding
 *   (smaller-ratio) axis — the more conservative of the two axes.
 */
function estimateEffectiveDpiAfterScale(image, scaleFactor) {
  const currentDpiX = image.intrinsicPixelWidth / (image.placedWidthPt / 72);
  const currentDpiY = image.intrinsicPixelHeight / (image.placedHeightPt / 72);
  const currentDpi = Math.min(currentDpiX, currentDpiY);
  return currentDpi / scaleFactor;
}

/**
 * The actual decision rule from smart-fix-engine-gap-closure.md §F:
 *   - no raster images on the page at all -> zero DPI cost, never blocks.
 *   - shrinking (scaleFactor <= 1) -> DPI can only improve, never blocks.
 *   - enlarging with no images -> vector/text only, not a DPI concern
 *     (still not SAFE_AUTOFIX on its own merit, but not blocked HERE).
 *   - enlarging with images -> blocked only if the predicted DPI would
 *     fall below MIN_SAFE_DPI.
 *
 * @param {{ hasRasterImages: boolean, scaleFactor: number, images?: Array<{intrinsicPixelWidth:number,intrinsicPixelHeight:number,placedWidthPt:number,placedHeightPt:number}> }} params
 * @returns {{ safe: boolean, reason: string, worstPredictedDpi: number|null }}
 */
function assessUpscaleDpiRisk(params) {
  if (params.scaleFactor <= 1) {
    return { safe: true, reason: 'Зменшення (або без змін) — ефективний DPI растрових зображень лише зростає або лишається тим самим.', worstPredictedDpi: null };
  }
  if (!params.hasRasterImages) {
    return { safe: true, reason: 'На сторінці немає растрових зображень — збільшення не впливає на якість растру.', worstPredictedDpi: null };
  }

  const predictedDpis = (params.images || []).map((img) => estimateEffectiveDpiAfterScale(img, params.scaleFactor));
  const worstPredictedDpi = predictedDpis.length > 0 ? Math.min(...predictedDpis) : null;

  if (worstPredictedDpi === null) {
    // hasRasterImages===true but no image metadata was provided — fail
    // safe: cannot prove it's fine, so it isn't treated as fine.
    return { safe: false, reason: 'Сторінка містить растрові зображення, але їх роздільна здатність не вимірювалась — ризик збільшення не можна підтвердити.', worstPredictedDpi: null };
  }

  if (worstPredictedDpi + 1e-6 >= MIN_SAFE_DPI) {
    return { safe: true, reason: `Прогнозований DPI (${worstPredictedDpi.toFixed(0)}) залишається на або вище безпечного порогу (${MIN_SAFE_DPI}).`, worstPredictedDpi };
  }

  return { safe: false, reason: `Прогнозований DPI (${worstPredictedDpi.toFixed(0)}) падає нижче безпечного порогу (${MIN_SAFE_DPI}) — збільшення не пропонується автоматично.`, worstPredictedDpi };
}

module.exports = { MIN_SAFE_DPI, estimateEffectiveDpiAfterScale, assessUpscaleDpiRisk };
