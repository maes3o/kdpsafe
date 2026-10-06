'use strict';

/**
 * Shared math for PROPORTIONAL_SCALE / SCALE_PLUS_PADDING — kept in one
 * place so both strategy modules (and any future one) agree on exactly
 * the same numbers, never two independently-written formulas that could
 * silently drift apart.
 *
 * scaleFactor = min(targetWidthPt/measuredWidthPt, targetHeightPt/measuredHeightPt)
 * — the largest uniform scale that still fits the page within the target
 * on BOTH axes (never overflows either axis).
 *
 * PROOF that scaleFactor <= 1 for every case Phase 2 actually reaches:
 * these two strategies only ever get a candidate from geometryProblems.js
 * problem kinds TOO_LARGE or WRONG_ASPECT — both of which, by that
 * module's own if/else chain, mean "at least one axis's deltaWidthPt/
 * deltaHeightPt (measured - target) is > TOLERANCE_PT", i.e. measured is
 * LARGER than target on that axis. For that axis, targetPt/measuredPt < 1,
 * so scaleFactor (the min of the two axis ratios) is <= that value, which
 * is < 1. Phase 2's registered strategies are therefore shrink-only by
 * construction — never reachable as an enlarge-direction transform through
 * any real detect() path. See dpiEstimator.js's header for what this means
 * for the upscale-DPI guard.
 */
function computeScalePlusPadding(measuredWidthPt, measuredHeightPt, targetWidthPt, targetHeightPt) {
  const scaleFactor = Math.min(targetWidthPt / measuredWidthPt, targetHeightPt / measuredHeightPt);
  const scaledWidthPt = measuredWidthPt * scaleFactor;
  const scaledHeightPt = measuredHeightPt * scaleFactor;
  const padWidthTotalPt = targetWidthPt - scaledWidthPt;
  const padHeightTotalPt = targetHeightPt - scaledHeightPt;
  return {
    scaleFactor,
    scaledWidthPt,
    scaledHeightPt,
    padWidthTotalPt,
    padHeightTotalPt,
    dx: padWidthTotalPt / 2,
    dy: padHeightTotalPt / 2,
  };
}

module.exports = { computeScalePlusPadding };
