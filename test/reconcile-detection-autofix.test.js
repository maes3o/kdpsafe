'use strict';

/**
 * Reconciliation pass between the new detection layer (classifyViolations,
 * lib/margin.js) and the existing autofix decision layer (planAutofix,
 * lib/autofix.js) -- run on the SAME fixtures already built for the
 * Margin/Bleed/LEM detection-only stage.
 *
 * Purpose (explicitly requested before any integration work, 2026-10-05):
 * show, case by case, whether detection's verdict and autofix's
 * eligibility decision AGREE. Updated after the first pass found exactly
 * one mismatch (the exact threshold boundary, float noise) -- per
 * explicit review feedback, the fix was scoped to exactly THREE things,
 * none of which touch planAutofix's actual decision logic:
 *   1. Extract the shared threshold + comparison into
 *      lib/marginPolicy.js (LEM_AUTOFIX_THRESHOLD_PT,
 *      THRESHOLD_EPSILON_PT, exceedsAutofixThreshold()) -- both
 *      classifyViolations() and planAutofix() now call the SAME helper
 *      instead of each comparing against a raw constant.
 *   2. pageBoxPt is NOT renamed (deferred) -- just documented in
 *      lib/autofix.js's planAutofix() jsdoc as semantically meaning the
 *      TRIM boundary. Zone-naming note, geometrically identical to this
 *      stage's trimBoxPt/bleedBoxPt (test/zones.js); touchedPageEdges()
 *      only compares raw numbers, so feeding it the right VALUES
 *      reconciles cleanly regardless of the parameter's name.
 *   3. classifyViolations() stays per-side (not collapsed);
 *      planAutofix() keeps its own one-decision-per-object shape. The
 *      explicit boundary between the two is
 *      lib/marginPolicy.js's aggregateViolationsForAutofix() -- shown in
 *      the matrix below for visibility, NOT called by either
 *      classifyViolations() or planAutofix() yet.
 *
 * Reconciliation rules under test (as specified for this pass):
 *   - text + LEM            -> detection 'error', autofix ALWAYS 'manual_review'
 *   - amountPt <= 7.2pt     -> detection 'warning', autofix candidate ('autofix'),
 *                              UNLESS the object also touches a trim edge
 *                              (autofix's bleed-guard overrides shift-autofix
 *                              there -- a structural case the two rules
 *                              interact on, not a contradiction)
 *   - amountPt > 7.2pt      -> detection 'error', autofix 'manual_review'
 *   - BLEED gap             -> detection 'error', autofix 'manual_review', never a shift
 *   - intentional bleed     -> detection: no violation, autofix 'safe'
 *   - image/path LEM        -> candidate (autofix 'autofix') only when
 *                              detection severity is 'warning'
 */

const assert = require('node:assert/strict');
const { analyzePageObjects, classifyViolations } = require('../lib/margin');
const { planAutofix, touchedPageEdges } = require('../lib/autofix');
const { aggregateViolationsForAutofix, LEM_AUTOFIX_THRESHOLD_PT } = require('../lib/marginPolicy');

function touchesAnyEdge(bbox, pageBoxPt) {
  const t = touchedPageEdges(bbox, pageBoxPt);
  return t.left || t.right || t.bottom || t.top;
}
const { zones, safeZoneBBoxPt, trimBoxPt, bleedBoxPt, mediaBoxSize } = require('./zones');
const {
  buildPathCasesFixture,
  buildRotatedPathFixture,
  buildNestedSaveRestoreFixture,
  buildClippedSafeFixture,
  buildTextCasesFixture,
  buildImageCasesFixture,
} = require('./make-safezone-fixtures');
const { buildFormXObjectFixture } = require('./make-form-xobject-fixture');

const autofixOpts = { pageBoxPt: trimBoxPt, bleedZoneBBoxPt: bleedBoxPt };

function runAutofix(obj) {
  return planAutofix(obj, safeZoneBBoxPt, autofixOpts);
}

function summarizeDetection(violations) {
  if (violations.length === 0) return 'safe';
  return violations.map((v) => `${v.violation}/${v.side}/${v.severity}(${v.amountPt.toFixed(2)}pt)`).join(', ');
}

const rows = [];
const mismatches = [];

function addCase(label, obj) {
  const detection = classifyViolations(obj, zones);
  const autofix = runAutofix(obj);
  rows.push({ label, type: obj.type, detection, autofix });
  return { detection, autofix };
}

/**
 * Check the reconciliation rules for one case and record any disagreement
 * (printed, not thrown -- a known float-boundary mismatch is expected and
 * documented below rather than hidden).
 */
function checkReconciliation(label, obj, detection, autofix) {
  if (detection.length === 0) {
    if (autofix.status !== 'safe') {
      mismatches.push(`[${label}] detection says safe, autofix says '${autofix.status}'`);
    }
    return;
  }

  for (const v of detection) {
    if (v.violation === 'LEM' && obj.type === 'text') {
      if (autofix.status !== 'manual_review') {
        mismatches.push(`[${label}] text LEM violation but autofix status is '${autofix.status}', expected 'manual_review'`);
      }
    } else if (v.violation === 'BLEED') {
      if (autofix.status !== 'manual_review' || autofix.shift) {
        mismatches.push(`[${label}] BLEED violation but autofix status is '${autofix.status}'${autofix.shift ? ' (with a shift!)' : ''}, expected 'manual_review' with no shift`);
      }
    } else if (v.violation === 'LEM' && v.severity === 'error') {
      if (autofix.status !== 'manual_review') {
        mismatches.push(`[${label}] LEM/error (amountPt=${v.amountPt.toFixed(3)}) but autofix status is '${autofix.status}', expected 'manual_review'`);
      }
    } else if (v.violation === 'LEM' && v.severity === 'warning') {
      const edgeTouched = obj.type !== 'text' && touchesAnyEdge(obj.visibleBBoxPt, trimBoxPt);
      if (edgeTouched) {
        // The edge-touch bleed-guard legitimately overrides ordinary
        // shift-autofix here -- 'manual_review' (never a shift) is the
        // expected, non-contradictory outcome in this sub-case.
        if (autofix.status !== 'manual_review' || autofix.shift) {
          mismatches.push(`[${label}] LEM/warning + edge-touching, expected the bleed-guard's 'manual_review' (no shift), got status '${autofix.status}'${autofix.shift ? ' with a shift' : ''}`);
        }
      } else if (autofix.status !== 'autofix') {
        mismatches.push(`[${label}] LEM/warning (amountPt=${v.amountPt.toFixed(3)}), not edge-touching, but autofix status is '${autofix.status}', expected 'autofix'`);
      }
    }
  }
}

async function run() {
  // Path cases (7): boundary ladder + intentional/partial bleed.
  {
    const { bytes, labels } = await buildPathCasesFixture();
    const results = await analyzePageObjects(bytes, 0);
    labels.forEach((label, i) => {
      const obj = results[i];
      const { detection, autofix } = addCase(label, obj);
      checkReconciliation(label, obj, detection, autofix);
    });
  }

  // Text cases (3).
  {
    const { bytes, labels } = await buildTextCasesFixture();
    const results = await analyzePageObjects(bytes, 0);
    labels.forEach((label, i) => {
      const obj = results[i];
      const { detection, autofix } = addCase(label, obj);
      checkReconciliation(label, obj, detection, autofix);
    });
  }

  // Image cases (3).
  {
    const { bytes, labels } = await buildImageCasesFixture();
    const results = await analyzePageObjects(bytes, 0);
    labels.forEach((label, i) => {
      const obj = results[i];
      const { detection, autofix } = addCase(label, obj);
      checkReconciliation(label, obj, detection, autofix);
    });
  }

  // Rotated path (AABB approximation, 2 side-violations collapsed into
  // ONE 2D autofix decision -- a structural granularity difference, not
  // a contradiction; recorded in the matrix for visibility).
  {
    const { bytes } = await buildRotatedPathFixture();
    const results = await analyzePageObjects(bytes, 0);
    const obj = results[0];
    const { detection, autofix } = addCase('rotated-path', obj);
    checkReconciliation('rotated-path', obj, detection, autofix);
  }

  // Nested q/Q (both safe).
  {
    const { bytes } = await buildNestedSaveRestoreFixture();
    const results = await analyzePageObjects(bytes, 0);
    results.forEach((obj, i) => {
      const label = `nested-qQ-${i}`;
      const { detection, autofix } = addCase(label, obj);
      checkReconciliation(label, obj, detection, autofix);
    });
  }

  // Clipping (raw violates, visible safe -- both layers must use visible).
  {
    const { bytes } = await buildClippedSafeFixture();
    const results = await analyzePageObjects(bytes, 0);
    const obj = results[0];
    const { detection, autofix } = addCase('clipped-safe', obj);
    checkReconciliation('clipped-safe', obj, detection, autofix);
  }

  // Nested Form XObject (LEM warning through a Form scope).
  {
    const px = safeZoneBBoxPt.minX - 15;
    const py = safeZoneBBoxPt.minY + 20;
    const { bytes } = await buildFormXObjectFixture({
      formBBox: { x: 0, y: 0, width: 50, height: 50 },
      rectInForm: { x: 10, y: 10, width: 30, height: 30 },
      placement: { x: px, y: py, scale: 1 },
      mainPageSize: mediaBoxSize,
    });
    const results = await analyzePageObjects(bytes, 0);
    const obj = results[0];
    const { detection, autofix } = addCase('nested-form-xobject', obj);
    checkReconciliation('nested-form-xobject', obj, detection, autofix);
  }

  // --- Print the reconciliation matrix (now including the explicit
  // aggregation-boundary column, lib/marginPolicy.js's
  // aggregateViolationsForAutofix -- shown for visibility only, still
  // not called by either planAutofix or classifyViolations). ---
  console.log('\n=== Detection <-> Aggregate <-> Autofix reconciliation matrix ===');
  console.log('label'.padEnd(28), 'type'.padEnd(6), 'detection'.padEnd(46), 'aggregate'.padEnd(16), 'autofix');
  for (const r of rows) {
    const autofixSummary = `${r.autofix.status}${r.autofix.shift ? ` (shift dx=${r.autofix.shift.dx.toFixed(2)},dy=${r.autofix.shift.dy.toFixed(2)})` : ''}`;
    const aggregate = aggregateViolationsForAutofix(r.detection).recommendedAction;
    console.log(r.label.padEnd(28), r.type.padEnd(6), summarizeDetection(r.detection).padEnd(46), aggregate.padEnd(16), autofixSummary);
  }

  console.log('\n=== Mismatches found ===');
  if (mismatches.length === 0) {
    console.log('(none)');
  } else {
    mismatches.forEach((m) => console.log('- ' + m));
  }

  // --- The previously-known exactly-0.1in float-boundary mismatch is
  // now RESOLVED (2026-10-05): both files call the same
  // exceedsAutofixThreshold() helper (lib/marginPolicy.js), so the same
  // floating-point noise (45 - 37.8 = 7.200000000000003, not 7.2) no
  // longer tips them to different verdicts. Proved explicitly, not just
  // by absence from `mismatches`: ---
  {
    const boundaryRow = rows.find((r) => r.label === 'exactly-0.1in-overshoot-lem');
    assert.ok(boundaryRow, 'the exact-boundary fixture case must still be present');
    assert.equal(boundaryRow.detection.length, 1, '[exactly-0.1in] still exactly one LEM violation');
    assert.equal(boundaryRow.detection[0].severity, 'warning', '[exactly-0.1in] detection: severity must be "warning" (at, not over, the threshold)');
    assert.ok(
      Math.abs(boundaryRow.detection[0].amountPt - LEM_AUTOFIX_THRESHOLD_PT) < 1e-3,
      `[exactly-0.1in] amountPt should be ~${LEM_AUTOFIX_THRESHOLD_PT}pt, got ${boundaryRow.detection[0].amountPt}`
    );
    assert.equal(boundaryRow.autofix.status, 'autofix', '[exactly-0.1in] autofix: status must be "autofix" (at, not over, the threshold) -- this is the line that used to read "manual_review"');
    assert.ok(
      Math.abs(boundaryRow.autofix.shift.dx - LEM_AUTOFIX_THRESHOLD_PT) < 1e-3,
      `[exactly-0.1in] autofix shift.dx should be ~${LEM_AUTOFIX_THRESHOLD_PT}pt, got ${boundaryRow.autofix.shift.dx}`
    );
    // And the explicit aggregation boundary (lib/marginPolicy.js's
    // aggregateViolationsForAutofix -- not called by either planAutofix
    // or classifyViolations themselves, see that function's own header)
    // must independently agree too.
    const aggregate = aggregateViolationsForAutofix(boundaryRow.detection);
    assert.equal(aggregate.recommendedAction, 'candidate', '[exactly-0.1in] aggregation boundary: recommendedAction must be "candidate"');
    console.log(`\n[exactly-0.1in-overshoot-lem] now IDENTICAL across all three: detection=${boundaryRow.detection[0].severity}, autofix=${boundaryRow.autofix.status}, aggregate=${aggregate.recommendedAction}.`);
  }

  // All cases must now reconcile cleanly -- ANY mismatch at this point is
  // a genuine, unexpected disagreement worth investigating before
  // integrating (the one known mismatch from the previous pass is gone).
  assert.deepEqual(mismatches, [], `unexpected detection/autofix disagreements:\n${mismatches.join('\n')}`);

  console.log(`\nAll margin-violations <-> autofix reconciliation checks passed (${rows.length} cases; 0 mismatches -- the previous exactly-0.1in float-boundary mismatch is now resolved).`);
  console.log('autofix.js behavior was NOT changed beyond the shared threshold comparison (exceedsAutofixThreshold from lib/marginPolicy.js, replacing a bare `> THRESHOLD_PT`).');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
