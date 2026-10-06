'use strict';

/**
 * Smart Fix Phase 2 — strategy selection/classification coverage.
 * Positive paths (PROPORTIONAL_SCALE, SCALE_PLUS_PADDING, the user's
 * explicit 8.5x11 -> 6x9+bleed scenario, mixed-strategy documents) plus
 * the headline safety-critical case: a page whose margin is exactly
 * compliant BEFORE scaling but would become non-compliant AFTER —
 * verified caught by the real dry-run (lib/smartfix/dryRun.js), not
 * skipped or coincidentally passed.
 */

const assert = require('node:assert/strict');
const { planRepair } = require('../lib/smartfix/smartFixEngine');
const fx = require('./make-smartfix-phase2-fixtures');

async function main() {
  // 1) The user's headline scenario: 8.5x11in -> 6x9in + bleed.
  {
    const result = await planRepair(await fx.build85x11ToTargetWithBleedBook(), fx.TARGET_6X9_WITH_BLEED);
    const plan = result.plans[0];
    assert.equal(plan.problem.kind, 'TOO_LARGE');
    assert.equal(plan.chosenStrategy.type, 'SCALE_PLUS_PADDING');
    assert.equal(plan.chosenStrategy.risk.level, 'USER_CONFIRMATION');
    assert.ok(plan.chosenStrategy.params.scaleFactor < 1, 'must be a shrink, never an enlarge');
    assert.equal(plan.chosenStrategy.params.targetWidthPt, 6.125 * 72);
    assert.equal(plan.chosenStrategy.params.targetHeightPt, 9.25 * 72);
    console.log('OK: 8.5x11 -> 6x9+bleed -> SCALE_PLUS_PADDING / USER_CONFIRMATION, dry-run clean.');
  }

  // 2) Aspect-ratio-matched oversized page -> pure PROPORTIONAL_SCALE,
  //    zero padding.
  {
    const result = await planRepair(await fx.buildAspectMatchedOversizedBook(), fx.TARGET_6X9_NO_BLEED);
    const plan = result.plans[0];
    assert.equal(plan.chosenStrategy.type, 'PROPORTIONAL_SCALE');
    assert.equal(plan.chosenStrategy.risk.level, 'USER_CONFIRMATION');
    assert.equal(plan.chosenStrategy.params.scaleFactor, 0.75);
    assert.equal(plan.chosenStrategy.params.dx, 0);
    assert.equal(plan.chosenStrategy.params.dy, 0);
    console.log('OK: aspect-matched oversized page -> PROPORTIONAL_SCALE / USER_CONFIRMATION, zero padding.');
  }

  // 3) SAFETY-CRITICAL: margin exactly compliant before scaling, would
  //    become non-compliant after -> dry-run must force MANUAL_REVIEW.
  {
    const result = await planRepair(await fx.buildScaleMarginViolationBook(), fx.TARGET_6X9_NO_BLEED);
    const plan = result.plans[0];
    assert.equal(plan.chosenStrategy, null, 'a scale that would violate margins must never be chosen, whatever its own risk tier would have been');
    assert.ok(/Dry-run/.test(plan.explanation), 'explanation must name the dry-run as the reason, not an unrelated cause');
    console.log('OK: margin-exactly-compliant-before/violating-after scale -> MANUAL_REVIEW via real dry-run, never silently applied.');
  }

  // 4) Rotated AND oversized -> rotation still blocks every strategy,
  //    scale strategies included (Phase 2 must not weaken this Phase 1
  //    guarantee).
  {
    const result = await planRepair(await fx.buildRotatedOversizedBook(), fx.TARGET_6X9_NO_BLEED);
    const plan = result.plans[0];
    assert.equal(plan.problem.kind, 'NON_ZERO_ROTATION');
    assert.equal(plan.chosenStrategy, null);
    console.log('OK: rotated + oversized -> MANUAL_REVIEW, PROPORTIONAL_SCALE/SCALE_PLUS_PADDING never proposed for a rotated page.');
  }

  // 5) Mixed-strategy document: one page needs PADDING, another needs
  //    PROPORTIONAL_SCALE — each planned independently and correctly.
  {
    const result = await planRepair(await fx.buildMixedStrategyBook(), fx.TARGET_6X9_NO_BLEED);
    assert.equal(result.plans[0].chosenStrategy.type, 'PADDING');
    assert.equal(result.plans[0].chosenStrategy.risk.level, 'SAFE_AUTOFIX');
    assert.equal(result.plans[1].chosenStrategy.type, 'PROPORTIONAL_SCALE');
    assert.equal(result.plans[1].chosenStrategy.risk.level, 'USER_CONFIRMATION');
    console.log('OK: mixed-strategy document -> each page gets its own correct strategy independently.');
  }

  // 6) Safe (simple /Rect) annotation on an oversized page -> scale still
  //    proceeds (the annotation will be rewritten, not blocked).
  {
    const result = await planRepair(await fx.buildOversizedBookWithSafeAnnotation(), fx.TARGET_6X9_NO_BLEED);
    const plan = result.plans[0];
    assert.equal(plan.chosenStrategy.type, 'PROPORTIONAL_SCALE');
    console.log('OK: simple /Rect annotation does not block an otherwise-safe scale.');
  }

  // 7) Complex-geometry annotation (/QuadPoints) on an oversized page ->
  //    MANUAL_REVIEW, never a silently-wrong annotation transform.
  {
    const result = await planRepair(await fx.buildOversizedBookWithComplexAnnotation(), fx.TARGET_6X9_NO_BLEED);
    const plan = result.plans[0];
    assert.equal(plan.chosenStrategy, null);
    assert.equal(plan.problem.kind, 'TOO_LARGE');
    console.log('OK: /QuadPoints annotation on an oversized page -> MANUAL_REVIEW, scale never proposed.');
  }

  // 8) Encrypted document, oversized content -> still DO_NOT_TOUCH at the
  //    document level, Phase 2 strategies never even considered.
  {
    const result = await planRepair(await fx.buildEncryptedOversizedPdf(), fx.TARGET_6X9_NO_BLEED);
    assert.equal(result.documentStatus, 'DO_NOT_TOUCH');
    assert.equal(result.plans.length, 0);
    console.log('OK: encrypted + oversized -> DO_NOT_TOUCH, zero plans (Phase 2 strategies never reached).');
  }

  console.log('\nAll Smart Fix Phase 2 strategy tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
