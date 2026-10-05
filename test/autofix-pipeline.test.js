'use strict';

/**
 * CHECKPOINT 4 (2026-10-05): autofix + re-verification regression/integration
 * tests -- lib/geometryRewriter.js, lib/pdfAutofixWriter.js, and
 * lib/orchestrator.js's verifyAutofix()/evaluateVerification().
 *
 * Central thing under test, per the user's own words: "Autofix НЕ
 * вважається успішним, поки змінений PDF не пройшов повторний preflight."
 * Every "VERIFIED" case below is only ever reached by re-parsing the
 * actually-written output bytes with the real pdfjs-based detector
 * (lib/margin.js's analyzePageObjects, via lib/orchestrator.js's own
 * runPreflight()) -- never asserted from the applyAutofix() call's own
 * reported success alone.
 *
 * TESTING-STRATEGY NOTE (read before changing any of this -- UPDATED
 * CHECKPOINT 5D, 2026-10-05, after this note itself was found stale during
 * the 5D audit): before CHECKPOINT 5C, the real engine's horizontal
 * safe-zone geometry was PERMANENTLY unresolved for every page, so
 * lib/orchestrator.js's allSidesAllowed() never let planAutofix() run
 * through the real runPreflight() pipeline at all. CHECKPOINT 5C changed
 * that: when userIntent.bleed === false and the page-count-dependent
 * margins are known, horizontal geometry now resolves -- either exactly
 * (userIntent.readingDirection + pageContext.pageNumber given) or to the
 * CHECKPOINT-5A-proven-safe conservative intersection (neither given) --
 * see lib/zones.js's own header for the full contract. Real,
 * end-to-end-reachable VERIFIED outcomes for conservative/exact/mixed
 * ambiguous+definite autofix are covered in test/checkpoint5d.test.js, not
 * here -- this file's Part C below is kept deliberately minimal (no
 * explicit /TrimBox at all in its fixture) and intentionally still proves
 * the OTHER, still-permanent limitation: a page with NO real /TrimBox
 * anchor in the file stays entirely geometry-`unavailable` (not merely
 * horizontally unresolved) regardless of CHECKPOINT 5C, because
 * lib/zoneGeometry.js's resolveTrimBoxPt() has no anchorless fallback for
 * trim itself (unlike the one CHECKPOINT 5C added for bleed) -- see that
 * function's own jsdoc. Consequently:
 *   - Parts A/B below test the byte-patch mechanics (geometryRewriter,
 *     pdfAutofixWriter) and the pure comparison logic (evaluateVerification)
 *     directly, against hand-built plans/results -- mirroring exactly how
 *     CHECKPOINT 3's Part A tested resolveAllowedSides() against geometry
 *     shapes the real engine couldn't produce yet at the time.
 *   - Part C is a genuine, no-shortcuts, real-pipeline integration test:
 *     calling verifyAutofix() through the ACTUAL runPreflight() on an
 *     ACTUAL PDF that has no explicit /TrimBox, proving that THIS
 *     specific, still-real limitation (no trim anchor => NOT VERIFIED,
 *     NO_APPLICABLE_AUTOFIX) continues to hold post-5C, with zero
 *     hand-built intermediate objects.
 */

const assert = require('node:assert/strict');
const {
  PDFDocument,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  setFillingRgbColor,
  fill,
} = require('pdf-lib');
const { shiftRectInContentStream } = require('../lib/geometryRewriter');
const { applyAutofix, getContentStreamEntries } = require('../lib/pdfAutofixWriter');
const { runPreflight, verifyAutofix, evaluateVerification } = require('../lib/orchestrator');
const { analyzePageObjects } = require('../lib/margin');

function rectOps(x, y, w, h) {
  return [pushGraphicsState(), setFillingRgbColor(0.2, 0.2, 0.2), rectangle(x, y, w, h), fill(), popGraphicsState()];
}

async function makeFixturePdf({ widthIn, heightIn, rects }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([widthIn * 72, heightIn * 72]);
  for (const r of rects || []) {
    page.pushOperators(...rectOps(r.x, r.y, r.width, r.height));
  }
  return doc.save();
}

// --- Part A: lib/geometryRewriter.js's shiftRectInContentStream() as a
// pure byte-patch unit (requirements #1, #2, #4, #9). ---

async function partA_geometryRewriter() {
  // A1: a plain rectangle, identity CTM, found and shifted; the ORIGINAL
  // buffer passed in is never mutated (requirement #9) -- only a new
  // Buffer is returned.
  {
    const bytes = await makeFixturePdf({ widthIn: 6, heightIn: 9, rects: [{ x: 5, y: 100, width: 20, height: 20 }] });
    const before = await analyzePageObjects(bytes.slice(), 0);
    assert.equal(before.length, 1, 'A1: one detected object before patching');

    const doc = await PDFDocument.load(bytes);
    const page = doc.getPages()[0];
    const entries = getContentStreamEntries(page, doc.context);
    assert.equal(entries.length, 1, 'A1: fixture has exactly one content-stream object');
    const { decodePDFRawStream, PDFName, PDFNumber } = require('pdf-lib');
    const originalDecoded = Buffer.from(decodePDFRawStream(entries[0].stream).decode());
    const originalDecodedCopy = Buffer.from(originalDecoded); // snapshot to compare against post-call

    const result = shiftRectInContentStream(originalDecoded, {
      targetRawBBoxPt: before[0].rawBBoxPt,
      dx: 22,
      dy: 5,
    });
    assert.equal(result.status, 'applied', 'A1: the rect is found and patched');
    assert.deepEqual(result.patch.before, { x: 5, y: 100 }, 'A1: patch records the original x/y');
    assert.deepEqual(result.patch.after, { x: 27, y: 105 }, 'A1: patch records the shifted x/y');
    assert.deepEqual(originalDecoded, originalDecodedCopy, 'A1: the ORIGINAL decoded buffer passed in was never mutated in place');

    entries[0].stream.contents = result.patchedBytes;
    // The patched bytes are plain, uncompressed content-stream text --
    // clear any pre-existing /Filter (e.g. none here, but mirrors what
    // lib/pdfAutofixWriter.js's applyAutofix() does for real when it
    // re-encodes with FlateDecode instead) so pdf-lib doesn't try to
    // Flate-decode plain text on a later read.
    entries[0].stream.dict.delete(PDFName.of('Filter'));
    entries[0].stream.dict.set(PDFName.of('Length'), PDFNumber.of(result.patchedBytes.length));
    const outputBytes = await doc.save();

    // Requirement #4: the problem actually disappears, re-confirmed by
    // re-PARSING the written bytes with the real pdfjs-based detector --
    // never just trusting the patch object's own claim.
    const after = await analyzePageObjects(outputBytes, 0);
    assert.equal(after.length, 1, 'A1: still exactly one object after the fix');
    assert.deepEqual(after[0].rawBBoxPt, { minX: 27, minY: 105, maxX: 47, maxY: 125 }, 'A1: the object really moved, confirmed by re-detection');

    // The ORIGINAL bytes (requirement #9, at the whole-PDF level too) are
    // untouched: re-detecting against the pristine `bytes` still finds the
    // object at its original position.
    const stillOriginal = await analyzePageObjects(bytes, 0);
    assert.deepEqual(stillOriginal[0].rawBBoxPt, { minX: 5, minY: 100, maxX: 25, maxY: 120 }, 'A1: original pdfBytes were never mutated by any step above');
  }

  // A2: 'not_found' when no rect in the stream matches the target geometry
  // -- never guesses, never silently "succeeds" on the wrong object.
  {
    const bytes = await makeFixturePdf({ widthIn: 6, heightIn: 9, rects: [{ x: 5, y: 100, width: 20, height: 20 }] });
    const doc = await PDFDocument.load(bytes);
    const entries = getContentStreamEntries(doc.getPages()[0], doc.context);
    const { decodePDFRawStream } = require('pdf-lib');
    const buf = Buffer.from(decodePDFRawStream(entries[0].stream).decode());

    const result = shiftRectInContentStream(buf, {
      targetRawBBoxPt: { minX: 999, minY: 999, maxX: 1019, maxY: 1019 }, // no such rect exists
      dx: 1,
      dy: 1,
    });
    assert.equal(result.status, 'not_found', 'A2: a non-matching target geometry is honestly reported as not_found, not guessed at');
  }

  // A3: 'ambiguous' when TWO rects share identical geometry -- refuses to
  // pick one rather than guessing which corresponds to the detector's
  // object (the two pipelines have no shared indexing to disambiguate).
  {
    const bytes = await makeFixturePdf({
      widthIn: 6,
      heightIn: 9,
      rects: [{ x: 5, y: 100, width: 20, height: 20 }, { x: 5, y: 100, width: 20, height: 20 }],
    });
    const doc = await PDFDocument.load(bytes);
    const entries = getContentStreamEntries(doc.getPages()[0], doc.context);
    const { decodePDFRawStream } = require('pdf-lib');
    const buf = Buffer.from(decodePDFRawStream(entries[0].stream).decode());

    const result = shiftRectInContentStream(buf, {
      targetRawBBoxPt: { minX: 5, minY: 100, maxX: 25, maxY: 120 },
      dx: 10,
      dy: 0,
    });
    assert.equal(result.status, 'ambiguous', 'A3: two identical-geometry candidates refuses to pick one');
  }

  console.log('[Part A] geometryRewriter.shiftRectInContentStream(): all 3 cases passed.');
}

// --- Part B: lib/pdfAutofixWriter.js's applyAutofix() against hand-built
// AutofixPlans (requirements #1, #7, #9), and lib/orchestrator.js's
// evaluateVerification() as a pure decision unit (requirements #4, #5, #6,
// #8) -- exercised directly since the real engine cannot reach a fully
// resolved geometry yet (see file header). ---

async function partB_applyAutofixAndEvaluation() {
  // B1: a single applyable plan gets applied; original bytes untouched;
  // output is a valid, re-parseable PDF whose object really moved.
  {
    const bytes = await makeFixturePdf({ widthIn: 6, heightIn: 9, rects: [{ x: 5, y: 100, width: 20, height: 20 }] });
    const detected = await analyzePageObjects(bytes.slice(), 0);
    const inspectionResult = {
      autofixPlans: [
        {
          pageIndex: 0,
          type: 'path',
          rawBBoxPt: detected[0].rawBBoxPt,
          visibleBBoxPt: detected[0].visibleBBoxPt,
          shift: { dx: 22, dy: 0 },
          fixedBBoxPt: { minX: 27, minY: 100, maxX: 47, maxY: 120 },
          applyable: true,
        },
      ],
    };

    const { outputBytes, applied, skipped } = await applyAutofix(bytes, inspectionResult);
    assert.equal(applied.length, 1, 'B1: one plan applied');
    assert.equal(skipped.length, 0, 'B1: nothing skipped');

    const after = await analyzePageObjects(outputBytes, 0);
    assert.equal(after[0].rawBBoxPt.minX, 27, 'B1: object really moved in the OUTPUT bytes');

    const stillOriginal = await analyzePageObjects(bytes, 0);
    assert.equal(stillOriginal[0].rawBBoxPt.minX, 5, 'B1: original pdfBytes passed to applyAutofix were never mutated (requirement #9)');
  }

  // B2: a plan whose target geometry doesn't exist in the stream (autofix
  // failure) is reported as skipped, not silently dropped or thrown.
  {
    const bytes = await makeFixturePdf({ widthIn: 6, heightIn: 9, rects: [{ x: 5, y: 100, width: 20, height: 20 }] });
    const inspectionResult = {
      autofixPlans: [
        {
          pageIndex: 0,
          type: 'path',
          rawBBoxPt: { minX: 999, minY: 999, maxX: 1019, maxY: 1019 },
          visibleBBoxPt: { minX: 999, minY: 999, maxX: 1019, maxY: 1019 },
          shift: { dx: 1, dy: 1 },
          applyable: true,
        },
      ],
    };
    const { applied, skipped } = await applyAutofix(bytes, inspectionResult);
    assert.equal(applied.length, 0, 'B2: nothing applied');
    assert.equal(skipped.length, 1, 'B2: the unlocatable plan is reported as skipped');
    assert.equal(skipped[0].reason, 'rect_not_found', 'B2: reason is explicit');
  }

  // B3 (requirement #4/#5, via evaluateVerification directly): the targeted
  // problem actually disappearing -> VERIFIED; the targeted problem's exact
  // bbox still present in AFTER -> NOT VERIFIED with ISSUE_REMAINS.
  {
    const plan = { pageIndex: 0, rawBBoxPt: { minX: 5, minY: 100, maxX: 25, maxY: 120 } };
    const appliedOk = [{ plan, patch: { before: { x: 5, y: 100 }, after: { x: 27, y: 100 } } }];

    const before = {
      violations: [{ pageIndex: 0, rawBBoxPt: plan.rawBBoxPt }],
      geometry: { pages: [{ allowedSides: { top: true, bottom: true, left: true, right: true } }] },
    };
    const afterFixed = {
      violations: [], // the object moved; no violation remains at all
      geometry: { pages: [{ allowedSides: { top: true, bottom: true, left: true, right: true } }] },
      verdict: 'READY', // CHECKPOINT 5E: evaluateVerification() now also requires after.verdict === 'READY'
    };
    const okResult = evaluateVerification(before, afterFixed, appliedOk, []);
    assert.deepEqual(okResult, { verification: 'VERIFIED', reasons: [] }, 'B3a: problem gone, nothing new, geometry resolved, verdict READY -> VERIFIED');

    const afterStillBroken = {
      violations: [{ pageIndex: 0, rawBBoxPt: plan.rawBBoxPt }], // same bbox, unmoved
      geometry: { pages: [{ allowedSides: { top: true, bottom: true, left: true, right: true } }] },
    };
    const badResult = evaluateVerification(before, afterStillBroken, appliedOk, []);
    assert.equal(badResult.verification, 'MANUAL_REVIEW_REQUIRED', 'B3b: problem still present -> NOT VERIFIED');
    assert.ok(badResult.reasons.includes('ISSUE_REMAINS'), 'B3b: reason is explicitly ISSUE_REMAINS');
  }

  // B4 (requirement #6): AFTER geometry still has a blocked side on any
  // page -> NOT VERIFIED with GEOMETRY_UNRESOLVED, even if the targeted
  // violation itself is gone.
  {
    const plan = { pageIndex: 0, rawBBoxPt: { minX: 5, minY: 100, maxX: 25, maxY: 120 } };
    const before = {
      violations: [{ pageIndex: 0, rawBBoxPt: plan.rawBBoxPt }],
      geometry: { pages: [{ allowedSides: { top: true, bottom: true, left: false, right: false } }] },
    };
    const after = {
      violations: [],
      geometry: { pages: [{ allowedSides: { top: true, bottom: true, left: false, right: false } }] },
    };
    const result = evaluateVerification(before, after, [{ plan, patch: {} }], []);
    assert.equal(result.verification, 'MANUAL_REVIEW_REQUIRED', 'B4: unresolved geometry blocks VERIFIED even when the fixed violation is gone');
    assert.ok(result.reasons.includes('GEOMETRY_UNRESOLVED'), 'B4: reason is explicitly GEOMETRY_UNRESOLVED');
  }

  // B5 (requirement #7): an autofix that couldn't be safely applied
  // (skipped non-empty) -> NOT VERIFIED, regardless of what AFTER shows.
  {
    const plan = { pageIndex: 0, rawBBoxPt: { minX: 5, minY: 100, maxX: 25, maxY: 120 } };
    const before = {
      violations: [{ pageIndex: 0, rawBBoxPt: plan.rawBBoxPt }],
      geometry: { pages: [{ allowedSides: { top: true, bottom: true, left: true, right: true } }] },
    };
    const after = {
      violations: [{ pageIndex: 0, rawBBoxPt: plan.rawBBoxPt }], // unchanged, since nothing was applied
      geometry: { pages: [{ allowedSides: { top: true, bottom: true, left: true, right: true } }] },
    };
    const result = evaluateVerification(before, after, [], [{ plan, reason: 'rect_not_found' }]);
    assert.equal(result.verification, 'MANUAL_REVIEW_REQUIRED', 'B5: a skipped (failed) autofix is never VERIFIED');
    assert.ok(result.reasons.includes('AUTOFIX_NOT_SAFELY_APPLICABLE'), 'B5: reason names the autofix failure explicitly');
  }

  // B6 (requirement #8): a brand-new violation appearing on a page that had
  // none before -> NOT VERIFIED with NEW_VIOLATIONS_AFTER_FIX, even though
  // the originally-targeted problem (elsewhere) is gone.
  {
    const plan = { pageIndex: 0, rawBBoxPt: { minX: 5, minY: 100, maxX: 25, maxY: 120 } };
    const before = {
      violations: [{ pageIndex: 0, rawBBoxPt: plan.rawBBoxPt }], // page 0 had exactly the targeted problem
      geometry: {
        pages: [
          { allowedSides: { top: true, bottom: true, left: true, right: true } },
          { allowedSides: { top: true, bottom: true, left: true, right: true } },
        ],
      },
    };
    const after = {
      violations: [
        // page 0's targeted violation is gone (good)...
        // ...but page 1, which had NOTHING before, now has a violation.
        { pageIndex: 1, rawBBoxPt: { minX: 1, minY: 1, maxX: 2, maxY: 2 } },
      ],
      geometry: {
        pages: [
          { allowedSides: { top: true, bottom: true, left: true, right: true } },
          { allowedSides: { top: true, bottom: true, left: true, right: true } },
        ],
      },
    };
    const result = evaluateVerification(before, after, [{ plan, patch: {} }], []);
    assert.equal(result.verification, 'MANUAL_REVIEW_REQUIRED', 'B6: a brand-new violation on an untouched page blocks VERIFIED');
    assert.ok(result.reasons.includes('NEW_VIOLATIONS_AFTER_FIX'), 'B6: reason is explicitly NEW_VIOLATIONS_AFTER_FIX');
  }

  console.log('[Part B] applyAutofix() + evaluateVerification(): all 6 cases passed.');
}

// --- Part C: a genuine, real-pipeline integration test -- no hand-built
// plans or results anywhere, just verifyAutofix() against a real PDF
// through the real runPreflight(). Proves requirement #9 end-to-end for
// the one geometry state that stays permanently unavailable even after
// CHECKPOINT 5C: a page with no explicit /TrimBox at all. (The
// conservative/exact/mixed-ambiguous VERIFIED-reaching cases CHECKPOINT 5C
// made newly reachable live in test/checkpoint5d.test.js, not here -- see
// this file's header, updated CHECKPOINT 5D after being found stale.) ---

async function partC_realPipelineIntegration() {
  // No explicit /TrimBox anywhere in this fixture (makeFixturePdf() above
  // never calls page.setTrimBox()) -- resolveTrimBoxPt() in
  // lib/zoneGeometry.js has no anchorless fallback for trim itself (unlike
  // the CHECKPOINT-5C-added one for bleed), so trimBoxPt stays null and
  // geometryStatus stays 'unavailable' regardless of readingDirection/
  // pageCount/bleed choice. This is a DIFFERENT, narrower reason than the
  // pre-5C "horizontal geometry is architecturally always unresolved"
  // this test originally documented -- updated here, not just left stale.
  const bytes = await makeFixturePdf({ widthIn: 6, heightIn: 9, rects: [{ x: 5, y: 100, width: 20, height: 20 }] });
  const opts = { userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }, pageContext: { pageCount: 100 } };

  const result = await verifyAutofix(bytes, opts);

  assert.equal(result.before.geometry.pages[0].status, 'unavailable', 'C1 precondition: no explicit /TrimBox -> geometry genuinely unavailable (not merely conservative/exact-unresolved)');
  assert.equal(result.verification, 'MANUAL_REVIEW_REQUIRED', 'C1: verifyAutofix() against a page with no trim anchor at all is NOT VERIFIED');
  assert.ok(result.reasons.includes('NO_APPLICABLE_AUTOFIX'), 'C1: reason explicitly names that nothing was applicable, not a vague failure');
  assert.equal(result.after, null, 'C1: no AFTER re-check PDF was even generated, since nothing was applied');
  assert.deepEqual(result.outputBytes, bytes, 'C1: output bytes equal the untouched original when nothing was applicable');

  // Confirm this is driven by the real before.verdict, not a shortcut.
  assert.equal(result.before.verdict, 'MANUAL_REVIEW_REQUIRED', 'C1: before.verdict is itself MANUAL_REVIEW_REQUIRED, consistent with CHECKPOINT 3');

  // verifyAutofix() never throws and never mutates the bytes it was given.
  const reDetect = await analyzePageObjects(bytes, 0);
  assert.equal(reDetect[0].rawBBoxPt.minX, 5, 'C1: original bytes passed to verifyAutofix were never mutated');

  console.log('[Part C] verifyAutofix() real-pipeline integration (no-trim-anchor case): 1 case passed.');
}

// --- Part D: regression for the real, pre-existing multi-page bug found
// while building Part C above (lib/margin.js's analyzePageObjects() used to
// hand pdfjs-dist the caller's own buffer, which pdfjs-dist detaches on
// load -- a second call with the same reference threw DataCloneError).
// runPreflight() calls analyzePageObjects() once per page with the SAME
// `pdfBytes` reference every time, so this silently broke every multi-page
// manuscript's preflight before today -- requirement #10 ("existing tests
// stay green") doesn't catch this because every prior fixture in this repo
// happened to be single-page. ---

async function partD_multiPageDetachRegression() {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage([6 * 72, 9 * 72]);
  page1.pushOperators(...rectOps(5, 100, 20, 20));
  const page2 = doc.addPage([6 * 72, 9 * 72]);
  page2.pushOperators(...rectOps(200, 200, 20, 20));
  const bytes = await doc.save();

  // Direct regression: calling analyzePageObjects twice with the SAME bytes
  // reference must not throw and must not detach the caller's buffer.
  const p1 = await analyzePageObjects(bytes, 0);
  const p2 = await analyzePageObjects(bytes, 1);
  assert.equal(p1.length, 1, 'D1: page 0 detected correctly after the fix');
  assert.equal(p2.length, 1, 'D1: page 1 ALSO detected correctly -- previously threw DataCloneError');

  // End-to-end: runPreflight() over a real 2-page document no longer
  // crashes either (it calls analyzePageObjects once per page internally).
  const result = await runPreflight(bytes, {
    userIntent: { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false },
    pageContext: { pageCount: 100 },
  });
  assert.equal(result.geometry.pages.length, 2, 'D2: runPreflight() processes both pages of a real multi-page PDF without throwing');

  console.log('[Part D] multi-page detach regression: 2 cases passed.');
}

async function main() {
  await partA_geometryRewriter();
  await partB_applyAutofixAndEvaluation();
  await partC_realPipelineIntegration();
  await partD_multiPageDetachRegression();
  console.log('\nAll autofix-pipeline.test.js cases passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
