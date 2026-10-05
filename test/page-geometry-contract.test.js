'use strict';

/**
 * PAGE-BOX + PAGE-ROTATION EMPIRICAL VALIDATION (2026-10-05 checkpoint).
 *
 * This file does NOT change production behavior. It establishes, by
 * actually running the project's existing dependencies (pdf-lib,
 * pdfjs-dist) and existing production function (analyzePageObjects()),
 * facts that the preceding ZONES CONTRACT AUDIT could only infer from
 * reading source. Every assertion below is a recorded OBSERVATION, not a
 * design decision -- see the final report for what these observations
 * mean for a future zones-builder.
 *
 * Part A: explicit /TrimBox and /BleedBox (real PDF-dictionary boxes).
 * Part B: page-level /Rotate.
 *
 * LEM is intentionally NOT tested here (per explicit instruction: LEM
 * policy is a separate product decision, out of scope for this
 * checkpoint).
 */

const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { analyzePageObjects } = require('../lib/margin');
const { buildExplicitPageBoxFixture, buildRotatedPageFixture } = require('./make-pagebox-fixtures');

async function partA_explicitPageBoxes() {
  const { bytes, mediaBoxPt, bleedBoxPt, trimBoxPt, rects } = await buildExplicitPageBoxFixture();

  // --- 1 & 2: can pdf-lib write/read /TrimBox and /BleedBox? What shape
  // and units come back? ---
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);

  const readMediaBox = page.getMediaBox();
  const readBleedBox = page.getBleedBox();
  const readTrimBox = page.getTrimBox();
  const readCropBox = page.getCropBox(); // not set explicitly -- observe its default

  // OBSERVED FACT: pdf-lib returns these as {x, y, width, height} (lower-
  // left corner + extents), in PDF points -- NOT the {minX,minY,maxX,maxY}
  // shape that lib/margin.js's `zones` parameter expects. A zones-builder
  // would have to convert explicitly; nothing in the repo does this today.
  assert.deepEqual(readMediaBox, { x: 0, y: 0, width: 500, height: 700 }, 'MediaBox must round-trip exactly as set');
  assert.deepEqual(readBleedBox, { x: 10, y: 10, width: 480, height: 680 }, 'BleedBox must round-trip exactly as set');
  assert.deepEqual(readTrimBox, { x: 30, y: 30, width: 440, height: 640 }, 'TrimBox must round-trip exactly as set');

  // OBSERVED FACT: CropBox was never set explicitly on this fixture, and
  // pdf-lib does NOT default it to MediaBox at read time when absent from
  // the dictionary and never written -- getCropBox() falls back to
  // MediaBox at the pdf-lib API level (confirmed by the value below), but
  // this is pdf-lib's own default-resolution behavior, not something
  // margin.js/autofix.js perform themselves (neither calls getCropBox at
  // all, confirmed by the earlier audit's grep).
  assert.deepEqual(readCropBox, { x: 0, y: 0, width: 500, height: 700 }, 'CropBox (unset) must read back as pdf-lib\'s MediaBox default');

  // Confirm the values are plain numbers in the same unit space the rest
  // of the project already treats as points (no separate unit/scale
  // factor involved) -- re-derive min/max form and compare to what we
  // set, as a second, independent check.
  const toMinMax = (b) => ({ minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height });
  assert.deepEqual(toMinMax(readMediaBox), mediaBoxPt, '3: MediaBox stays in the same point coordinate system we wrote it in');
  assert.deepEqual(toMinMax(readBleedBox), bleedBoxPt, '3: BleedBox stays in the same point coordinate system we wrote it in');
  assert.deepEqual(toMinMax(readTrimBox), trimBoxPt, '3: TrimBox stays in the same point coordinate system we wrote it in');
  // 4: confirmed above by the deepEqual against toMinMax(...)Pt -- same
  // {minX,minY,maxX,maxY} semantics as margin.js's zones, modulo the
  // {x,y,width,height}<->{minX,minY,maxX,maxY} shape conversion itself.

  // --- 5 & 6: does analyzePageObjects() read the same coordinate system,
  // and does it react to the explicit boxes at all? ---
  const objs = await analyzePageObjects(bytes, 0);
  assert.equal(objs.length, 3, 'all three rects must be detected regardless of which box band they fall in');

  const expectedRawBBoxes = {
    'inside-trim': { minX: 100, minY: 100, maxX: 150, maxY: 150 },
    'bleed-to-trim-band': { minX: 15, minY: 100, maxX: 25, maxY: 150 },
    'media-to-bleed-band': { minX: 2, minY: 100, maxX: 7, maxY: 150 },
  };
  const order = ['inside-trim', 'bleed-to-trim-band', 'media-to-bleed-band'];
  objs.forEach((obj, i) => {
    const label = order[i];
    // 5: analyzePageObjects()'s returned bbox is in the SAME raw PDF
    // user-space as the explicit boxes we just read back above (e.g. the
    // 'media-to-bleed-band' rect's minX=2 sits, as expected, outside
    // bleedBoxPt.minX=10 using the exact same numbers/unit space).
    assert.deepEqual(obj.rawBBoxPt, expectedRawBBoxes[label], `rect '${label}' must report its exact raw content-stream position`);
    assert.deepEqual(obj.visibleBBoxPt, expectedRawBBoxes[label], `rect '${label}' is unclipped, so visibleBBoxPt must equal rawBBoxPt`);
  });

  // 6: does the current code ignore the explicit boxes, as expected?
  // Proof by construction: analyzePageObjects() was called with ONLY
  // pdfBytes+pageIndex -- it has no parameter through which the explicit
  // TrimBox/BleedBox we set could even reach it. The identical rawBBoxPt
  // values above (unperturbed, unclipped, exactly matching the content
  // stream) confirm no implicit box-based filtering or clipping happened
  // either (e.g. 'media-to-bleed-band', which is OUTSIDE the declared
  // BleedBox, was still detected in full, not clipped to the BleedBox).
  console.log('Part A (explicit TrimBox/BleedBox): confirmed analyzePageObjects() ignores them entirely -- object bboxes are the raw content-stream geometry, independent of any PDF-dictionary box.');

  // 7: confirm test/zones.js's synthetic zones are NOT derived from (and
  // do not match) this fixture's real PDF boxes -- they're a completely
  // separate, hand-picked set of numbers. (This fixture's trimBoxPt is
  // 30..470 x 30..670 on a 500x700 page; zones.js's trimBoxPt is 9..441 x
  // 9..657 on a 450x666 page -- deliberately different on every axis.)
  const zones = require('./zones');
  assert.notDeepEqual(zones.trimBoxPt, trimBoxPt, '7: zones.js\'s synthetic trimBoxPt must not coincidentally equal this fixture\'s real TrimBox');
  assert.notDeepEqual(zones.bleedBoxPt, bleedBoxPt, '7: zones.js\'s synthetic bleedBoxPt must not coincidentally equal this fixture\'s real BleedBox');

  console.log('Part A (page-box contract) passed: pdf-lib writes/reads /TrimBox and /BleedBox correctly as {x,y,width,height} in points; analyzePageObjects() and classifyViolations() never see or use them; zones.js is confirmed fully synthetic.');
}

async function partB_pageRotation() {
  const results = {};
  for (const angleDeg of [0, 90, 180, 270]) {
    const { bytes, rect } = await buildRotatedPageFixture(angleDeg);

    // pdf-lib's own view of rotation/size.
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    const rotation = page.getRotation().angle;
    const size = page.getSize();
    assert.equal(rotation, angleDeg, `pdf-lib must read back the /Rotate angle we set (${angleDeg})`);
    // 1: pdf-lib's getSize()/getMediaBox() reports the UNROTATED MediaBox
    // dimensions regardless of /Rotate -- it never swaps width/height for
    // 90/270. This is the exact mechanism behind lib/manuscript.js's own
    // documented caveat (it calls getSize(), which is rotation-blind).
    assert.deepEqual(size, { width: 300, height: 500 }, `pdf-lib getSize() must stay unrotated (raw MediaBox) regardless of /Rotate=${angleDeg}`);

    // lib/margin.js's analyzePageObjects() -- the actual production
    // detection path.
    const objs = await analyzePageObjects(bytes, 0);
    assert.equal(objs.length, 1);
    const expectedRawBBoxPt = { minX: rect.x, minY: rect.y, maxX: rect.x + rect.width, maxY: rect.y + rect.height };

    // 2 & 3 & 4: does visibleBBoxPt change under /Rotate? Observed: NO.
    // analyzePageObjects() uses pdf.js's getOperatorList(), which replays
    // the raw content stream in its own (unrotated) user-space -- it
    // never consults /Rotate or applies a viewport transform. The
    // returned bbox is therefore IDENTICAL at every rotation angle,
    // still expressed in the same base PDF user-space as the unrotated
    // case.
    assert.deepEqual(objs[0].rawBBoxPt, expectedRawBBoxPt, `analyzePageObjects() must return the SAME raw-space bbox at /Rotate=${angleDeg} as at /Rotate=0 (observed: rotation-invariant)`);

    results[angleDeg] = { rotation, size, bbox: objs[0].rawBBoxPt };
  }

  // Cross-angle check: all four angles produced byte-identical bbox
  // output -- confirms "rotation-invariant", not just "correct at one
  // angle by coincidence".
  const bboxStrings = Object.values(results).map((r) => JSON.stringify(r.bbox));
  assert.equal(new Set(bboxStrings).size, 1, 'analyzePageObjects() bbox output must be identical across all four rotation angles');

  // 5: is this the same coordinate system as the (unrotated) zones
  // representation test/zones.js uses? Since analyzePageObjects() never
  // varies with rotation at all, and zones.js's zones are themselves
  // plain unrotated numbers, the two ARE compatible today only in the
  // narrow, accidental sense that neither one ever rotates -- there is no
  // code anywhere that would keep them compatible if a real production
  // zones-builder ever DID account for /Rotate while detection continued
  // not to (see final report, point 7 unknowns).

  // 6: is any page rotation currently applied by OUR OWN code? Observed:
  // no -- confirmed by the rotation-invariance above, and independently
  // by the absence of any `/Rotate`/`getRotation`/`rotate` read in
  // lib/margin.js, lib/autofix.js, or lib/manuscript.js (grep, prior
  // audit).
  console.log('Part B (page rotation) passed: pdf-lib reports unrotated getSize() regardless of /Rotate; analyzePageObjects() returns rotation-invariant (raw content-stream) bboxes at 0/90/180/270 degrees; our code applies no rotation transform anywhere.');
}

async function main() {
  await partA_explicitPageBoxes();
  await partB_pageRotation();
  console.log('All page-geometry-contract tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
