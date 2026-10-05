'use strict';

/**
 * Unit tests for lib/zones.js's buildZones() -- the isolated,
 * NOT-production-wired policy -> geometry layer (2026-10-05 implementation
 * checkpoint). Exactly the 26 cases requested for this checkpoint, in the
 * same numbering.
 *
 * This file does NOT touch analyzePageObjects()/classifyViolations()/
 * planAutofix()/planAutofixForPage(), and does not modify any existing
 * fixture file. pdf-lib-shaped PDF boxes ({x,y,width,height}) are built
 * by hand here (not via pdf-lib itself) since lib/zones.js only needs
 * plain objects in that shape, not real PDF files.
 */

const assert = require('node:assert/strict');
const { buildZones, inToPt } = require('../lib/zones');

function pdfBox(x, y, widthPt, heightPt) {
  return { x, y, width: widthPt, height: heightPt };
}

let caseCount = 0;
function runCase(label, fn) {
  caseCount += 1;
  fn();
  console.log(`  [${caseCount}] ${label}: OK`);
}

function main() {
  // --- 1. 6x9 no bleed ---
  runCase('1. 6x9 no bleed', () => {
    const result = buildZones({ pageCount: 100 }, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
    assert.deepEqual(result.trimBoxPt, { minX: 0, minY: 0, maxX: inToPt(6), maxY: inToPt(9) });
    assert.equal(result.bleedBoxPt, null, 'no-bleed intent must produce bleedBoxPt=null');
    assert.deepEqual(result.marginsPt, { topPt: inToPt(0.25), bottomPt: inToPt(0.25), outsidePt: inToPt(0.25), insidePt: inToPt(0.375) });
    assert.equal(result.safeZoneBBoxPt.minX, null);
    assert.equal(result.safeZoneBBoxPt.maxX, null);
    assert.equal(result.safeZoneBBoxPt.minY, inToPt(0.25));
    assert.equal(result.safeZoneBBoxPt.maxY, inToPt(9) - inToPt(0.25));
    assert.equal(result.confidence, 'high');
  });

  // --- 2. 6x9 with bleed ---
  runCase('2. 6x9 with bleed', () => {
    const result = buildZones({ pageCount: 100 }, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true });
    assert.deepEqual(result.trimBoxPt, { minX: 0, minY: 0, maxX: inToPt(6), maxY: inToPt(9) });
    assert.equal(result.bleedBoxPt.minX, null);
    assert.equal(result.bleedBoxPt.maxX, null);
    assert.equal(result.bleedBoxPt.minY, 0 - inToPt(0.125));
    assert.equal(result.bleedBoxPt.maxY, inToPt(9) + inToPt(0.125));
    assert.deepEqual(result.marginsPt, { topPt: inToPt(0.375), bottomPt: inToPt(0.375), outsidePt: inToPt(0.375), insidePt: inToPt(0.375) });
    assert.equal(result.safeZoneBBoxPt.minY, inToPt(0.375));
    assert.equal(result.safeZoneBBoxPt.maxY, inToPt(9) - inToPt(0.375));
    assert.equal(result.confidence, 'high');
    assert.ok(result.diagnostics.some((d) => d.code === 'BLEED_HORIZONTAL_EDGE_UNRESOLVED_WITHOUT_PAGE_PARITY'));
  });

  // --- 3. 5x8 no bleed ---
  runCase('3. 5x8 no bleed', () => {
    const result = buildZones({ pageCount: 100 }, { trimSize: { widthIn: 5, heightIn: 8 }, bleed: false });
    assert.deepEqual(result.trimBoxPt, { minX: 0, minY: 0, maxX: inToPt(5), maxY: inToPt(8) });
    assert.equal(result.bleedBoxPt, null);
    assert.equal(result.safeZoneBBoxPt.minY, inToPt(0.25));
    assert.equal(result.safeZoneBBoxPt.maxY, inToPt(8) - inToPt(0.25));
    assert.equal(result.confidence, 'high');
  });

  // --- 4. 5x8 with bleed ---
  runCase('4. 5x8 with bleed', () => {
    const result = buildZones({ pageCount: 100 }, { trimSize: { widthIn: 5, heightIn: 8 }, bleed: true });
    assert.equal(result.bleedBoxPt.minY, 0 - inToPt(0.125));
    assert.equal(result.bleedBoxPt.maxY, inToPt(8) + inToPt(0.125));
    assert.equal(result.safeZoneBBoxPt.minY, inToPt(0.375));
    assert.equal(result.safeZoneBBoxPt.maxY, inToPt(8) - inToPt(0.375));
    assert.equal(result.confidence, 'high');
  });

  // --- 5-14: KDP gutter table boundaries, both ends of every row ---
  const gutterBoundaries = [
    [24, 0.375],
    [150, 0.375],
    [151, 0.5],
    [300, 0.5],
    [301, 0.625],
    [500, 0.625],
    [501, 0.75],
    [700, 0.75],
    [701, 0.875],
    [828, 0.875],
  ];
  gutterBoundaries.forEach(([pageCount, expectedInsideIn], idx) => {
    runCase(`${5 + idx}. pageCount ${pageCount}`, () => {
      const result = buildZones({ pageCount }, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
      assert.equal(result.marginsPt.insidePt, inToPt(expectedInsideIn), `pageCount=${pageCount} must map to inside margin ${expectedInsideIn}in`);
      assert.equal(result.confidence, 'high');
      assert.ok(!result.diagnostics.some((d) => d.code === 'PAGE_COUNT_MISSING' || d.code === 'PAGE_COUNT_OUT_OF_SUPPORTED_RANGE'));
    });
  });

  // --- 15. pageCount missing ---
  runCase('15. pageCount missing', () => {
    const result = buildZones({}, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
    assert.equal(result.marginsPt.insidePt, null, 'insidePt must not be guessed when pageCount is missing');
    assert.equal(result.marginsPt.topPt, inToPt(0.25), 'top/bottom/outside do not depend on pageCount and must still be computed');
    assert.equal(result.confidence, 'insufficient');
    assert.ok(result.diagnostics.some((d) => d.code === 'PAGE_COUNT_MISSING'));
    // vertical safe-zone extent still computable (doesn't need insidePt)
    assert.equal(result.safeZoneBBoxPt.minY, inToPt(0.25));
    assert.equal(result.safeZoneBBoxPt.maxY, inToPt(9) - inToPt(0.25));
  });

  // --- 16. pageCount outside supported range ---
  runCase('16. pageCount outside supported range', () => {
    const tooFew = buildZones({ pageCount: 10 }, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
    assert.equal(tooFew.marginsPt.insidePt, null);
    assert.equal(tooFew.confidence, 'insufficient');
    assert.ok(tooFew.diagnostics.some((d) => d.code === 'PAGE_COUNT_OUT_OF_SUPPORTED_RANGE'));

    const tooMany = buildZones({ pageCount: 900 }, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
    assert.equal(tooMany.marginsPt.insidePt, null);
    assert.equal(tooMany.confidence, 'insufficient');
    assert.ok(tooMany.diagnostics.some((d) => d.code === 'PAGE_COUNT_OUT_OF_SUPPORTED_RANGE'));
  });

  // --- 17. TrimBox consistent ---
  runCase('17. TrimBox consistent', () => {
    const result = buildZones(
      { pageCount: 100, pdfBoxes: { trimBox: pdfBox(9, 9, inToPt(6), inToPt(9)) } },
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }
    );
    assert.ok(result.diagnostics.some((d) => d.code === 'TRIM_BOX_CONSISTENT'));
    assert.equal(result.confidence, 'high');
  });

  // --- 18. TrimBox conflict ---
  runCase('18. TrimBox conflict', () => {
    const result = buildZones(
      { pageCount: 100, pdfBoxes: { trimBox: pdfBox(9, 9, inToPt(5), inToPt(8)) } }, // 5x8, not 6x9
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }
    );
    assert.ok(result.diagnostics.some((d) => d.code === 'TRIM_BOX_CONFLICTS_WITH_USER_INTENT'));
    assert.equal(result.confidence, 'conflict');
  });

  // --- 19. BleedBox consistent ---
  runCase('19. BleedBox consistent', () => {
    const expectedBleedWidthPt = inToPt(6) + inToPt(0.125);
    const expectedBleedHeightPt = inToPt(9) + inToPt(0.25);
    const result = buildZones(
      { pageCount: 100, pdfBoxes: { bleedBox: pdfBox(0, 0, expectedBleedWidthPt, expectedBleedHeightPt) } },
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true }
    );
    assert.ok(result.diagnostics.some((d) => d.code === 'BLEED_BOX_CONSISTENT'));
    assert.equal(result.confidence, 'high');
  });

  // --- 20. BleedBox conflict ---
  runCase('20. BleedBox conflict', () => {
    const result = buildZones(
      { pageCount: 100, pdfBoxes: { bleedBox: pdfBox(0, 0, inToPt(6.5), inToPt(9.5)) } }, // matches neither trim nor trim+bleed
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true }
    );
    assert.ok(result.diagnostics.some((d) => d.code === 'BLEED_BOX_CONFLICTS_WITH_USER_INTENT'));
    assert.equal(result.confidence, 'conflict');
  });

  // --- 21. MediaBox looks like trim ---
  runCase('21. MediaBox looks like trim', () => {
    const result = buildZones(
      { pageCount: 100, pdfBoxes: { mediaBox: pdfBox(0, 0, inToPt(6), inToPt(9)) } },
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }
    );
    assert.ok(result.diagnostics.some((d) => d.code === 'MEDIA_BOX_LOOKS_LIKE_TRIM'));
    assert.equal(result.confidence, 'high', 'MediaBox hints must never change confidence');
  });

  // --- 22. MediaBox looks like trim+bleed ---
  runCase('22. MediaBox looks like trim+bleed', () => {
    const result = buildZones(
      { pageCount: 100, pdfBoxes: { mediaBox: pdfBox(0, 0, inToPt(6) + inToPt(0.125), inToPt(9) + inToPt(0.25)) } },
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true }
    );
    assert.ok(result.diagnostics.some((d) => d.code === 'MEDIA_BOX_LOOKS_LIKE_TRIM_PLUS_BLEED'));
    assert.equal(result.confidence, 'high');
  });

  // --- 23. MediaBox ambiguous ---
  runCase('23. MediaBox ambiguous', () => {
    const result = buildZones(
      { pageCount: 100, pdfBoxes: { mediaBox: pdfBox(0, 0, inToPt(6.6), inToPt(9.6)) } }, // matches neither
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false }
    );
    assert.ok(result.diagnostics.some((d) => d.code === 'MEDIA_BOX_AMBIGUOUS'));
    assert.equal(result.confidence, 'high', 'MediaBox ambiguity alone must never force conflict/insufficient');
  });

  // --- 24. user no-bleed + PDF geometry appears bleed ---
  runCase('24. user no-bleed + PDF geometry appears bleed', () => {
    const expectedBleedWidthPt = inToPt(6) + inToPt(0.125);
    const expectedBleedHeightPt = inToPt(9) + inToPt(0.25);
    const result = buildZones(
      { pageCount: 100, pdfBoxes: { bleedBox: pdfBox(0, 0, expectedBleedWidthPt, expectedBleedHeightPt) } },
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false } // user explicitly said NO bleed
    );
    assert.ok(result.diagnostics.some((d) => d.code === 'BLEED_BOX_GEOMETRY_IMPLIES_BLEED_BUT_USER_SAID_NO_BLEED'));
    assert.equal(result.confidence, 'conflict', 'PDF geometry must never silently override a no-bleed user intent');
    assert.equal(result.bleedBoxPt, null, 'bleedBoxPt stays null -- user intent, not PDF geometry, decides this field');
  });

  // --- 25. user bleed + PDF geometry inconsistent ---
  runCase('25. user bleed + PDF geometry inconsistent', () => {
    const result = buildZones(
      { pageCount: 100, pdfBoxes: { bleedBox: pdfBox(0, 0, inToPt(6.5), inToPt(9.5)) } }, // neither trim nor trim+bleed shape
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true }
    );
    assert.ok(result.diagnostics.some((d) => d.code === 'BLEED_BOX_CONFLICTS_WITH_USER_INTENT'));
    assert.equal(result.confidence, 'conflict');
  });

  // --- 26. non-zero /Rotate ---
  runCase('26. non-zero /Rotate', () => {
    const unrotated = buildZones({ pageCount: 100, rotationDeg: 0 }, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
    const rotated = buildZones({ pageCount: 100, rotationDeg: 90 }, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
    assert.ok(rotated.diagnostics.some((d) => d.code === 'NON_ZERO_PAGE_ROTATION'));
    assert.ok(!unrotated.diagnostics.some((d) => d.code === 'NON_ZERO_PAGE_ROTATION'));
    // No geometry transformation: identical trimBoxPt/safeZoneBBoxPt
    // regardless of rotationDeg, confirming "diagnostic only, no transform".
    assert.deepEqual(rotated.trimBoxPt, unrotated.trimBoxPt);
    assert.deepEqual(rotated.safeZoneBBoxPt, unrotated.safeZoneBBoxPt);
    assert.equal(rotated.confidence, 'high', 'rotation alone must never degrade confidence');
  });

  console.log(`\nAll ${caseCount} zones-builder test cases passed.`);
}

main();
