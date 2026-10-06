'use strict';

/**
 * White-box unit coverage for the insufficient-DPI upscale guard
 * (lib/smartfix/dpiEstimator.js). As that module's own header documents:
 * every strategy Phase 2 actually registers (PROPORTIONAL_SCALE,
 * SCALE_PLUS_PADDING) is mathematically proven shrink-only
 * (scaleFactor <= 1) given how their own detect() is scoped — so the
 * enlarge-direction (scaleFactor > 1) branch of this guard can never be
 * exercised through a real end-to-end detect() -> classify() path today.
 * This is tested directly instead, exactly as the user's instruction
 * anticipated ("додай regression tests для кожного safety-critical
 * випадку" — insufficient DPI included), and documented honestly here
 * and in the closing report, rather than claiming end-to-end coverage
 * that does not exist.
 */

const assert = require('node:assert/strict');
const { assessUpscaleDpiRisk, estimateEffectiveDpiAfterScale, MIN_SAFE_DPI } = require('../lib/smartfix/dpiEstimator');

function main() {
  // 1) Shrinking never blocks, regardless of images.
  assert.equal(assessUpscaleDpiRisk({ hasRasterImages: true, scaleFactor: 0.5 }).safe, true);
  assert.equal(assessUpscaleDpiRisk({ hasRasterImages: true, scaleFactor: 1 }).safe, true);
  console.log('OK: shrinking (scaleFactor<=1) never blocked by the DPI guard, regardless of images.');

  // 2) Enlarging with no raster images never blocks (vector/text only).
  assert.equal(assessUpscaleDpiRisk({ hasRasterImages: false, scaleFactor: 2 }).safe, true);
  console.log('OK: enlarging a page with no raster images is never blocked by the DPI guard.');

  // 3) Enlarging WITH images: predicted DPI comfortably above
  //    MIN_SAFE_DPI -> safe.
  {
    const result = assessUpscaleDpiRisk({
      hasRasterImages: true,
      scaleFactor: 1.2,
      images: [{ intrinsicPixelWidth: 3000, intrinsicPixelHeight: 3000, placedWidthPt: 432, placedHeightPt: 432 }],
    });
    assert.equal(result.safe, true);
    assert.ok(result.worstPredictedDpi > MIN_SAFE_DPI);
    console.log(`OK: enlarge with high-res image -> safe (predicted ${result.worstPredictedDpi.toFixed(0)} DPI >= ${MIN_SAFE_DPI}).`);
  }

  // 4) Enlarging WITH images: predicted DPI below MIN_SAFE_DPI -> unsafe,
  //    MANUAL_REVIEW-worthy (this is the actual safety-critical case the
  //    guard exists for).
  {
    const result = assessUpscaleDpiRisk({
      hasRasterImages: true,
      scaleFactor: 3,
      images: [{ intrinsicPixelWidth: 600, intrinsicPixelHeight: 600, placedWidthPt: 432, placedHeightPt: 432 }],
    });
    assert.equal(result.safe, false);
    assert.ok(result.worstPredictedDpi < MIN_SAFE_DPI);
    console.log(`OK: enlarge with low-res image -> unsafe (predicted ${result.worstPredictedDpi.toFixed(0)} DPI < ${MIN_SAFE_DPI}), guard blocks it.`);
  }

  // 5) Enlarging WITH images present but no per-image metadata supplied
  //    -> fails SAFE (cannot prove it's fine, so it isn't treated as fine).
  {
    const result = assessUpscaleDpiRisk({ hasRasterImages: true, scaleFactor: 1.5 });
    assert.equal(result.safe, false);
    console.log('OK: enlarge with unmeasured images -> fails safe (unsafe), never assumed fine.');
  }

  // 6) estimateEffectiveDpiAfterScale: direct arithmetic check — binding
  //    (smaller-ratio) axis wins, and dividing by scaleFactor is correct.
  {
    const dpi = estimateEffectiveDpiAfterScale(
      { intrinsicPixelWidth: 1000, intrinsicPixelHeight: 2000, placedWidthPt: 100, placedHeightPt: 100 },
      2
    );
    // currentDpiX = 1000/(100/72) = 720; currentDpiY = 2000/(100/72) = 1440;
    // binding = min = 720; after scale 2 -> 360.
    assert.ok(Math.abs(dpi - 360) < 0.01, `expected 360, got ${dpi}`);
    console.log('OK: estimateEffectiveDpiAfterScale arithmetic correct (binding axis, divided by scaleFactor).');
  }

  console.log('\nAll Smart Fix DPI-guard tests passed.');
}

main();
