'use strict';

/**
 * SAFETY OVER COVERAGE — the one thing this test file exists to prove:
 * for every case where Phase 1 cannot DOCUMENTABLY prove a strategy is
 * safe, the planner must return MANUAL_REVIEW and NEVER a chosenStrategy
 * (whatever its risk level would have been). This is checked both
 * through the public engine entry point (planRepair) and, for the
 * rotation/origin/box-conflict/too-large/wrong-aspect cases, by asserting
 * there is no code path that could have produced SAFE_AUTOFIX or
 * USER_CONFIRMATION instead.
 */

const assert = require('node:assert/strict');
const { planRepair } = require('../lib/smartfix/smartFixEngine');
const fx = require('./make-smartfix-fixtures');

function assertManualReviewOnly(plan, label) {
  assert.equal(plan.chosenStrategy, null, `${label}: chosenStrategy must be null, never a proposed strategy`);
  assert.equal(plan.alternativeStrategies.length, 0, `${label}: no alternative strategies should exist either`);
  assert.ok(plan.problem !== null, `${label}: a PageGeometryProblem must be recorded (not silently skipped)`);
}

async function planSinglePage(bytes, intent) {
  const result = await planRepair(bytes, intent || fx.TARGET_6X9_NO_BLEED);
  assert.equal(result.documentStatus, 'ANALYZED');
  assert.equal(result.plans.length, 1);
  return result.plans[0];
}

async function main() {
  // 1) Non-zero /Rotate — Phase 1 has no rotation-aware adapter, so this
  //    must ALWAYS be MANUAL_REVIEW, even though the page's raw MediaBox
  //    dimensions happen to exactly match the target.
  const rotatedPlan = await planSinglePage(await fx.buildRotatedExactSizePage());
  assertManualReviewOnly(rotatedPlan, 'rotated page');
  assert.equal(rotatedPlan.problem.kind, 'NON_ZERO_ROTATION');
  console.log('OK: non-zero /Rotate -> MANUAL_REVIEW only, never a proposed strategy.');

  // 2) Non-zero MediaBox origin — Phase 1 has no content-translation
  //    writer; must always be MANUAL_REVIEW.
  const originPlan = await planSinglePage(await fx.buildNonZeroOriginExactSizePage());
  assertManualReviewOnly(originPlan, 'non-zero origin page');
  assert.equal(originPlan.problem.kind, 'NON_ZERO_ORIGIN');
  console.log('OK: non-zero MediaBox origin -> MANUAL_REVIEW only.');

  // 3) Page LARGER than target on every axis — PROPORTIONAL_SCALE/SAFE_CROP
  //    are out of scope for Phase 1; must never be padded or otherwise
  //    "fixed" by shrinking content.
  const tooLargePlan = await planSinglePage(await fx.buildTooLargePage());
  assertManualReviewOnly(tooLargePlan, 'too-large page');
  assert.equal(tooLargePlan.problem.kind, 'TOO_LARGE');
  console.log('OK: oversized page -> MANUAL_REVIEW only, never scaled/cropped/padded.');

  // 4) Mixed growth/shrink (wider than target, shorter than target) — not
  //    a pure "smaller on every axis" case, so PADDING must never apply;
  //    must be MANUAL_REVIEW.
  const mixedPlan = await planSinglePage(await fx.buildMixedGrowthShrinkPage());
  assertManualReviewOnly(mixedPlan, 'mixed growth/shrink page');
  assert.equal(mixedPlan.problem.kind, 'WRONG_ASPECT');
  console.log('OK: mixed growth/shrink page -> MANUAL_REVIEW only, never a one-axis-only pad.');

  // 5) Explicit /TrimBox that CONFLICTS with user-confirmed trim size,
  //    even though the page's own MediaBox is exactly the target size —
  //    BOX_NORMALIZATION must refuse to silently overwrite a disagreeing,
  //    explicit box.
  const conflictPlan = await planSinglePage(await fx.buildExactSizeConflictingTrimBox());
  assertManualReviewOnly(conflictPlan, 'conflicting /TrimBox page');
  assert.equal(conflictPlan.problem.kind, 'BOX_CONFLICT');
  console.log('OK: conflicting explicit /TrimBox -> MANUAL_REVIEW only, never silently rewritten.');

  // 6) Encrypted/signed documents must never even reach a per-page
  //    MANUAL_REVIEW plan — they are blocked at the document level
  //    (DO_NOT_TOUCH), a stronger guarantee than per-page MANUAL_REVIEW.
  //    (Full coverage of this is in smartfix-hardgate.test.js; this is a
  //    cross-check that the planner-safety suite agrees.)
  const encryptedResult = await planRepair(await fx.buildEncryptedPdf(), fx.TARGET_6X9_NO_BLEED);
  assert.equal(encryptedResult.documentStatus, 'DO_NOT_TOUCH');
  assert.equal(encryptedResult.plans.length, 0);
  console.log('OK: encrypted document -> DO_NOT_TOUCH (stronger than per-page MANUAL_REVIEW).');

  // 7) Defense-in-depth on the central override itself: directly exercise
  //    applyCentralSafetyOverride() with a hand-built "problem" of a kind
  //    no Phase 1 strategy targets, alongside a candidate that (if the
  //    override did not exist) would otherwise have survived — the
  //    override must strip it regardless of the candidate's own risk
  //    level.
  // 'NON_ZERO_ROTATION' is used here specifically because it is a problem
  // kind NO strategy (Phase 1 or Phase 2) ever targets — unlike 'TOO_LARGE'/
  // 'WRONG_ASPECT', which Phase 2's PROPORTIONAL_SCALE/SCALE_PLUS_PADDING
  // now legitimately target (see repairPlanner.js's
  // STRATEGY_TARGETABLE_PROBLEM_KINDS).
  const { applyCentralSafetyOverride } = require('../lib/smartfix/repairPlanner');
  const fakeProblem = { pageIndex: 0, kind: 'NON_ZERO_ROTATION', detail: 'test', measured: {}, expected: {} };
  const fakeCandidate = { type: 'FAKE_STRATEGY', risk: { level: 'SAFE_AUTOFIX', reasons: ['should never survive'] } };
  const survivors = applyCentralSafetyOverride(fakeProblem, [fakeCandidate]);
  assert.equal(survivors.length, 0, 'central override must strip every candidate for an untargetable problem kind, regardless of its own classify() result');
  console.log('OK: central safety override strips candidates for untargetable problem kinds, even a self-declared SAFE_AUTOFIX one.');

  console.log('\nAll Smart Fix planner-safety tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
