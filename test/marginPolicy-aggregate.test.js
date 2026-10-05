'use strict';

/**
 * Dedicated unit tests for lib/marginPolicy.js's
 * aggregateViolationsForAutofix() -- requested explicitly (2026-10-05
 * validation checkpoint) because until now this function was exercised
 * ONLY indirectly, inside test/reconcile-detection-autofix.test.js's
 * matrix printout (called there "for visibility", not asserted on in
 * isolation -- see that file's own comments). These tests construct
 * violations arrays BY HAND (no PDF/fixture involved) so the function's
 * own contract is pinned down independently of classifyViolations()'s
 * geometry.
 *
 * This file does NOT change lib/marginPolicy.js. Every assertion below
 * matches the function's EXISTING, already-documented behavior (see its
 * jsdoc in lib/marginPolicy.js) -- these tests exist to pin that
 * contract down explicitly, not to change it.
 */

const assert = require('node:assert/strict');
const { aggregateViolationsForAutofix, LEM_AUTOFIX_THRESHOLD_PT } = require('../lib/marginPolicy');

function v(overrides) {
  return Object.assign(
    { type: 'path', violation: 'LEM', side: 'left', amountPt: 1, severity: 'warning' },
    overrides
  );
}

function main() {
  // 1) Zero violations -> 'safe', and all the summary fields at their
  // empty defaults (per the function's own early-return branch).
  {
    const result = aggregateViolationsForAutofix([]);
    assert.equal(result.recommendedAction, 'safe', 'zero violations must aggregate to safe');
    assert.equal(result.hasText, false);
    assert.equal(result.hasBleed, false);
    assert.equal(result.maxAmountPt, 0);
    assert.deepEqual(result.sides, []);
  }

  // 2) Warning-only (non-text, non-bleed, severity 'warning') -> 'candidate'.
  {
    const violations = [v({ side: 'left', amountPt: 3, severity: 'warning' })];
    const result = aggregateViolationsForAutofix(violations);
    assert.equal(result.recommendedAction, 'candidate', 'warning-only LEM must aggregate to candidate');
    assert.equal(result.hasText, false);
    assert.equal(result.hasBleed, false);
    assert.equal(result.maxAmountPt, 3);
    assert.deepEqual(result.sides, ['left']);
  }

  // 2b) Warning-only, MULTIPLE sides -> still 'candidate', maxAmountPt is
  // the larger of the two, sides lists both (order = input order, per
  // the function's plain .map()).
  {
    const violations = [
      v({ side: 'left', amountPt: 5, severity: 'warning' }),
      v({ side: 'top', amountPt: 3, severity: 'warning' }),
    ];
    const result = aggregateViolationsForAutofix(violations);
    assert.equal(result.recommendedAction, 'candidate');
    assert.equal(result.maxAmountPt, 5, 'maxAmountPt must be the larger of the two per-side amounts');
    assert.deepEqual(result.sides, ['left', 'top']);
  }

  // 3) Error-only (non-text, non-bleed, severity 'error') -> 'manual_review'.
  {
    const violations = [v({ side: 'top', amountPt: 14, severity: 'error' })];
    const result = aggregateViolationsForAutofix(violations);
    assert.equal(result.recommendedAction, 'manual_review', 'error-severity LEM must aggregate to manual_review');
    assert.equal(result.hasText, false);
    assert.equal(result.hasBleed, false);
    assert.equal(result.maxAmountPt, 14);
  }

  // 4) Text violation -> 'manual_review', UNCONDITIONALLY, even when the
  // violation's own severity is 'warning' (classifyViolations() never
  // actually emits text+warning per its own rules, but
  // aggregateViolationsForAutofix()'s hasText check is independent of
  // severity by construction -- pin that down explicitly).
  {
    const violations = [v({ type: 'text', side: 'bottom', amountPt: 2, severity: 'warning' })];
    const result = aggregateViolationsForAutofix(violations);
    assert.equal(result.recommendedAction, 'manual_review', 'any text violation must aggregate to manual_review regardless of severity');
    assert.equal(result.hasText, true);
    assert.equal(result.hasBleed, false);
  }

  // 5) Bleed violation -> 'manual_review', unconditionally (BLEED is
  // always severity 'error' per classifyViolations(), but again
  // hasBleed's effect here is independent of severity by construction).
  {
    const violations = [v({ violation: 'BLEED', side: 'right', amountPt: 6, severity: 'error' })];
    const result = aggregateViolationsForAutofix(violations);
    assert.equal(result.recommendedAction, 'manual_review', 'any BLEED violation must aggregate to manual_review');
    assert.equal(result.hasBleed, true);
    assert.equal(result.hasText, false);
  }

  // 6) Mixed LEM + BLEED on different sides -> 'manual_review', with both
  // hasBleed and (the LEM side's own severity) correctly reported, and
  // maxAmountPt/sides covering BOTH entries, not just the bleed one.
  {
    const violations = [
      v({ violation: 'BLEED', side: 'left', amountPt: 6, severity: 'error' }),
      v({ violation: 'LEM', side: 'top', amountPt: 3, severity: 'warning' }),
    ];
    const result = aggregateViolationsForAutofix(violations);
    assert.equal(result.recommendedAction, 'manual_review', 'mixed LEM+BLEED must aggregate to manual_review');
    assert.equal(result.hasBleed, true);
    assert.equal(result.hasText, false);
    assert.equal(result.maxAmountPt, 6, 'maxAmountPt must be the larger of the BLEED and LEM amounts');
    assert.deepEqual(result.sides, ['left', 'top']);
  }

  // 7) Exactly-at-threshold warning (amountPt === LEM_AUTOFIX_THRESHOLD_PT)
  // stays 'candidate' -- the aggregation boundary must not re-derive its
  // own threshold comparison; it only reads the severity
  // classifyViolations() already assigned. Confirms (at the aggregation
  // layer specifically) the same at-threshold-is-still-eligible contract
  // already covered for classifyViolations()/planAutofix() themselves in
  // test/reconcile-detection-autofix.test.js.
  {
    const violations = [v({ side: 'left', amountPt: LEM_AUTOFIX_THRESHOLD_PT, severity: 'warning' })];
    const result = aggregateViolationsForAutofix(violations);
    assert.equal(result.recommendedAction, 'candidate', 'exactly-at-threshold warning must still aggregate to candidate');
  }

  console.log('All aggregateViolationsForAutofix() unit tests passed (8 cases).');
}

main();
