'use strict';

/**
 * Positive-path coverage: the cases Phase 1 SHOULD confidently handle,
 * with the exact strategy and safety level expected — BOX_NORMALIZATION
 * (TrimBox/BleedBox missing or already consistent) and PADDING (page
 * smaller on every axis), plus the magnitude-based SAFE_AUTOFIX vs.
 * USER_CONFIRMATION split, mixed-page-size independence, and the
 * "repair plan + explanation" deliverable itself.
 */

const assert = require('node:assert/strict');
const { planRepair } = require('../lib/smartfix/smartFixEngine');
const fx = require('./make-smartfix-fixtures');

async function planSinglePage(bytes, intent) {
  const result = await planRepair(bytes, intent || fx.TARGET_6X9_NO_BLEED);
  assert.equal(result.documentStatus, 'ANALYZED');
  assert.equal(result.plans.length, 1);
  return { result, plan: result.plans[0] };
}

async function main() {
  // 1) Page already exactly the target size, no explicit /TrimBox ->
  //    BOX_NORMALIZATION, SAFE_AUTOFIX, content-preserving.
  {
    const { plan } = await planSinglePage(await fx.buildExactSizeNoBoxes());
    assert.equal(plan.problem, null, 'no problem should be flagged — the page is already the right size');
    assert.ok(plan.chosenStrategy, 'BOX_NORMALIZATION should be proposed');
    assert.equal(plan.chosenStrategy.type, 'BOX_NORMALIZATION');
    assert.equal(plan.chosenStrategy.risk.level, 'SAFE_AUTOFIX');
    assert.equal(plan.chosenStrategy.params.writeTrimBox, true);
    assert.equal(plan.chosenStrategy.contentPreserving, true);
    assert.ok(plan.explanation.length > 0, 'explanation string must be non-empty');
    console.log('OK: exact size, no TrimBox -> BOX_NORMALIZATION / SAFE_AUTOFIX.');
  }

  // 2) Page already exactly the target size AND already has a consistent
  //    explicit /TrimBox -> nothing to do at all (no candidate, no
  //    problem — genuinely compliant already).
  {
    const { plan } = await planSinglePage(await fx.buildExactSizeConsistentTrimBox());
    assert.equal(plan.problem, null);
    assert.equal(plan.chosenStrategy, null);
    assert.ok(/вже відповідає/.test(plan.explanation), 'explanation should say the page is already compliant');
    console.log('OK: exact size with already-consistent TrimBox -> no-op, correctly explained.');
  }

  // 3) Bleed requested, MediaBox already exactly trim+bleed, no boxes
  //    declared -> BOX_NORMALIZATION proposes writing BOTH TrimBox and
  //    BleedBox, still SAFE_AUTOFIX (box-dict-only, zero content risk).
  {
    const { plan } = await planSinglePage(await fx.buildExactSizeWithBleedNoBoxes(), fx.TARGET_6X9_WITH_BLEED);
    assert.equal(plan.problem, null);
    assert.ok(plan.chosenStrategy);
    assert.equal(plan.chosenStrategy.type, 'BOX_NORMALIZATION');
    assert.equal(plan.chosenStrategy.risk.level, 'SAFE_AUTOFIX');
    assert.equal(plan.chosenStrategy.params.writeTrimBox, true);
    assert.equal(plan.chosenStrategy.params.writeBleedBox, true);
    console.log('OK: trim+bleed exact match, no boxes -> BOX_NORMALIZATION writes TrimBox+BleedBox, SAFE_AUTOFIX.');
  }

  // 4) Page smaller by a tiny amount (0.02in, well under the 0.05in
  //    report-1 threshold) -> PADDING, SAFE_AUTOFIX.
  {
    const { plan } = await planSinglePage(await fx.buildTooSmallPage(0.02));
    assert.equal(plan.problem.kind, 'TOO_SMALL');
    assert.ok(plan.chosenStrategy);
    assert.equal(plan.chosenStrategy.type, 'PADDING');
    assert.equal(plan.chosenStrategy.risk.level, 'SAFE_AUTOFIX');
    assert.equal(plan.chosenStrategy.contentPreserving, true);
    console.log('OK: 0.02in deficit -> PADDING / SAFE_AUTOFIX (below the 0.05in threshold).');
  }

  // 5) Page smaller by a large amount (0.5in, clearly a different trim
  //    size) -> PADDING, but USER_CONFIRMATION, never silently applied.
  {
    const { plan } = await planSinglePage(await fx.buildTooSmallPage(0.5));
    assert.equal(plan.problem.kind, 'TOO_SMALL');
    assert.ok(plan.chosenStrategy);
    assert.equal(plan.chosenStrategy.type, 'PADDING');
    assert.equal(plan.chosenStrategy.risk.level, 'USER_CONFIRMATION');
    console.log('OK: 0.5in deficit -> PADDING / USER_CONFIRMATION (above the 0.05in threshold).');
  }

  // 6) Exactly at the 0.05in boundary -> still SAFE_AUTOFIX (<=, not <).
  {
    const { plan } = await planSinglePage(await fx.buildTooSmallPage(0.05));
    assert.equal(plan.chosenStrategy.risk.level, 'SAFE_AUTOFIX');
    console.log('OK: exactly 0.05in deficit -> still SAFE_AUTOFIX (boundary is inclusive).');
  }

  // 7) Mixed-page-size document: page 0 already exact, page 1 too small
  //    by 0.5in — each page must get its OWN correct, independent plan;
  //    the smaller page's deficit must never be computed against page 0
  //    instead of the user's actual target.
  {
    const result = await planRepair(await fx.buildMixedPageSizesDoc(), fx.TARGET_6X9_NO_BLEED);
    assert.equal(result.documentStatus, 'ANALYZED');
    assert.equal(result.document.pageSizeConsistent, false, 'manuscript.js should correctly flag the size inconsistency');
    assert.equal(result.plans.length, 2);

    const [page0, page1] = result.plans;
    assert.equal(page0.pageIndex, 0);
    assert.equal(page0.problem, null);
    assert.equal(page0.chosenStrategy.type, 'BOX_NORMALIZATION');

    assert.equal(page1.pageIndex, 1);
    assert.equal(page1.problem.kind, 'TOO_SMALL');
    assert.equal(page1.chosenStrategy.type, 'PADDING');
    assert.equal(page1.chosenStrategy.risk.level, 'USER_CONFIRMATION');
    // The target each page is compared against must be the SAME
    // user-confirmed trim size, never page 0's own measured size.
    assert.equal(page1.chosenStrategy.params.targetWidthPt, 6 * 72);
    assert.equal(page1.chosenStrategy.params.targetHeightPt, 9 * 72);

    console.log('OK: mixed page sizes -> each page planned independently against the SAME user-confirmed target.');
  }

  // 8) Both pages too small by tiny, sub-threshold amounts -> both
  //    SAFE_AUTOFIX, independently.
  {
    const result = await planRepair(await fx.buildMixedTooSmallSafeDoc(), fx.TARGET_6X9_NO_BLEED);
    assert.equal(result.plans.length, 2);
    for (const plan of result.plans) {
      assert.equal(plan.chosenStrategy.type, 'PADDING');
      assert.equal(plan.chosenStrategy.risk.level, 'SAFE_AUTOFIX');
    }
    console.log('OK: two independently-too-small pages, both sub-threshold -> both SAFE_AUTOFIX.');
  }

  console.log('\nAll Smart Fix planner positive-path tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
