'use strict';

/**
 * Shared Margin/LEM policy constants + comparison helper.
 *
 * Extracted 2026-10-05, after the detection/autofix reconciliation pass
 * found the two layers disagreeing at the "exactly 0.1in overshoot"
 * boundary case: lib/margin.js's classifyViolations() had its own
 * threshold-comparison epsilon (added after hitting the exact same float
 * issue there), but lib/autofix.js's planAutofix() did not, so identical
 * binary floating-point noise (45 - 37.8 evaluates to
 * 7.200000000000003 in JS, not 7.2) tipped the two files to different
 * verdicts at the same nominal boundary. Both files now import this
 * module and call exceedsAutofixThreshold() instead of each keeping (and
 * each having to remember to epsilon-guard) their own copy of the
 * comparison.
 *
 * This is the ONLY place the 0.1in/7.2pt shift-autofix-eligibility
 * threshold is defined. Both lib/margin.js (classifyViolations, for
 * detection severity) and lib/autofix.js (planAutofix, for the actual
 * autofix/manual_review decision) must use exceedsAutofixThreshold()
 * rather than re-deriving or re-comparing against the raw constant, so
 * the two layers can never silently drift apart at the boundary again.
 */

// 0.1in -- KDP/project-agreed threshold: a non-text LEM violation this
// small or smaller stays eligible for the shift-based autofix; anything
// larger (or any text violation, regardless of size -- see
// lib/autofix.js's own text rule, which is independent of this constant)
// goes to manual review instead.
const LEM_AUTOFIX_THRESHOLD_PT = 0.1 * 72; // 7.2pt

// Float-noise allowance on the THRESHOLD comparison itself -- distinct
// from margin.js's own TOLERANCE_PT (which governs whether a violation
// exists at all, i.e. export/rounding noise around a boundary edge).
// This epsilon exists purely so that a value which is mathematically
// EXACTLY LEM_AUTOFIX_THRESHOLD_PT doesn't get pushed to "exceeds" by
// floating-point subtraction noise upstream (e.g. 45 - 37.8).
const THRESHOLD_EPSILON_PT = 1e-6;

/**
 * Is `amountPt` (a LEM overshoot or shift magnitude, in points) OVER the
 * shift-autofix threshold? Exactly-at-the-threshold is deliberately NOT
 * "exceeds" -- the original rule (from both files, independently, before
 * this extraction) was a strict `>`, so equality stays autofix-eligible;
 * the epsilon here only protects that intent from float noise, it does
 * not change where the line is drawn.
 *
 * @param {number} amountPt
 * @returns {boolean}
 */
function exceedsAutofixThreshold(amountPt) {
  return amountPt > LEM_AUTOFIX_THRESHOLD_PT + THRESHOLD_EPSILON_PT;
}

/**
 * Collapse a PER-SIDE violations array (lib/margin.js's
 * classifyViolations() output) into a single OBJECT-LEVEL summary, in
 * the same shape lib/autofix.js's planAutofix() reasons in (one decision
 * per object, not per side).
 *
 * This is the explicit reconciliation/aggregation BOUNDARY between the
 * two layers, added 2026-10-05 per an explicit decision to keep the two
 * layers' granularity as-is rather than changing either one to match the
 * other: classifyViolations() stays per-side (detection's job is to
 * describe exactly what's wrong, on every side it's wrong on);
 * planAutofix() keeps deciding independently, in its own 2D
 * shift-geometry terms, from its own inputs (a single visibleBBoxPt, not
 * a violations list). Neither of those two functions calls this one yet
 * -- it exists purely as a well-defined translation point for a FUTURE
 * integration to use, so that integration has one place to do the
 * per-side -> per-object translation instead of either layer reaching
 * into the other's internals, or detection's granularity being flattened
 * to accommodate autofix's.
 *
 * Aggregation rule (mirrors the reconciliation rules verified against
 * planAutofix on 18 fixtures, 2026-10-05):
 *   - no violations at all -> 'safe'
 *   - any TEXT violation, or any BLEED violation, or any violation with
 *     severity 'error' -> 'manual_review' (all three are unconditional
 *     per lib/autofix.js's own rules: text is never auto-corrected,
 *     bleed gaps never get a shift, and 'error' severity already means
 *     "past the autofix threshold" by classifyViolations()'s own
 *     definition)
 *   - otherwise (every violation present is a non-text, non-bleed 'LEM'
 *     violation with severity 'warning') -> 'candidate': ELIGIBLE for
 *     autofix, not a guarantee of it -- this function does not compute a
 *     shift or know about edge-touching/bleed-guard geometry, both of
 *     which planAutofix() still decides on its own from the raw bbox.
 *
 * @param {Array<{type: string, violation: string, side: string, amountPt: number, severity: string}>} violations
 * @returns {{
 *   recommendedAction: 'safe' | 'candidate' | 'manual_review',
 *   hasText: boolean,
 *   hasBleed: boolean,
 *   maxAmountPt: number,
 *   sides: string[],
 * }}
 */
function aggregateViolationsForAutofix(violations) {
  if (violations.length === 0) {
    return { recommendedAction: 'safe', hasText: false, hasBleed: false, maxAmountPt: 0, sides: [] };
  }

  const hasText = violations.some((v) => v.type === 'text');
  const hasBleed = violations.some((v) => v.violation === 'BLEED');
  const hasError = violations.some((v) => v.severity === 'error');
  const maxAmountPt = Math.max(...violations.map((v) => v.amountPt));
  const sides = violations.map((v) => v.side);

  const recommendedAction = hasText || hasBleed || hasError ? 'manual_review' : 'candidate';

  return { recommendedAction, hasText, hasBleed, maxAmountPt, sides };
}

module.exports = {
  LEM_AUTOFIX_THRESHOLD_PT,
  THRESHOLD_EPSILON_PT,
  exceedsAutofixThreshold,
  aggregateViolationsForAutofix,
};
