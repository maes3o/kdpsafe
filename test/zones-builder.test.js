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
const { buildZones, inToPt, BLEED_INSIDE_IN } = require('../lib/zones');

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
  // CHECKPOINT 5C (2026-10-05): updated for Option D. Without
  // userIntent.readingDirection, safeZoneBBoxPt's horizontal axis is no
  // longer left `null` -- it resolves to the CONSERVATIVE,
  // orientation-independent intersection(LTR,RTL) zone, proven safe in
  // CHECKPOINT 5A. insidePt(27pt) >= outsidePt(18pt) here, so
  // max(insidePt,outsidePt)=insidePt=27pt on both sides.
  runCase('1. 6x9 no bleed', () => {
    const result = buildZones({ pageCount: 100 }, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
    assert.deepEqual(result.trimBoxPt, { minX: 0, minY: 0, maxX: inToPt(6), maxY: inToPt(9) });
    assert.equal(result.bleedBoxPt, null, 'no-bleed intent must produce bleedBoxPt=null');
    assert.deepEqual(result.marginsPt, { topPt: inToPt(0.25), bottomPt: inToPt(0.25), outsidePt: inToPt(0.25), insidePt: inToPt(0.375) });
    assert.equal(result.horizontalResolution, 'conservative');
    const conservativeMarginPt = inToPt(0.375); // max(insidePt=0.375in, outsidePt=0.25in)
    assert.equal(result.safeZoneBBoxPt.minX, conservativeMarginPt);
    assert.equal(result.safeZoneBBoxPt.maxX, inToPt(6) - conservativeMarginPt);
    assert.equal(result.safeZoneBBoxPt.minY, inToPt(0.25));
    assert.equal(result.safeZoneBBoxPt.maxY, inToPt(9) - inToPt(0.25));
    assert.deepEqual(result.orientationHypotheses, {
      ltr: { minX: inToPt(0.375), maxX: inToPt(6) - inToPt(0.25) },
      rtl: { minX: inToPt(0.25), maxX: inToPt(6) - inToPt(0.375) },
    });
    assert.equal(result.insideIsLeft, null, 'conservative mode never resolves a single physical side');
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

  // --- 27-30. CHECKPOINT 5C: exact orientation resolution via
  // userIntent.readingDirection + pageContext.pageNumber ---

  // 27. LTR, odd page -> inside=left
  runCase('27. LTR odd page -> inside=left', () => {
    const result = buildZones(
      { pageCount: 100, pageNumber: 5 },
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'ltr' }
    );
    assert.equal(result.horizontalResolution, 'exact');
    assert.equal(result.insideIsLeft, true);
    assert.equal(result.orientationHypotheses, null, 'exact mode does not need hypothesis boxes');
    assert.equal(result.safeZoneBBoxPt.minX, inToPt(0.375)); // insidePt on the left
    assert.equal(result.safeZoneBBoxPt.maxX, inToPt(6) - inToPt(0.25)); // outsidePt on the right
    assert.ok(result.diagnostics.some((d) => d.code === 'SAFE_ZONE_HORIZONTAL_RESOLVED_EXACT_ORIENTATION'));
  });

  // 28. LTR, even page -> inside=right
  runCase('28. LTR even page -> inside=right', () => {
    const result = buildZones(
      { pageCount: 100, pageNumber: 6 },
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'ltr' }
    );
    assert.equal(result.insideIsLeft, false);
    assert.equal(result.safeZoneBBoxPt.minX, inToPt(0.25)); // outsidePt on the left
    assert.equal(result.safeZoneBBoxPt.maxX, inToPt(6) - inToPt(0.375)); // insidePt on the right
  });

  // 29. RTL, odd page -> inverted (inside=right)
  runCase('29. RTL odd page -> inside=right', () => {
    const result = buildZones(
      { pageCount: 100, pageNumber: 5 },
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'rtl' }
    );
    assert.equal(result.insideIsLeft, false);
    assert.equal(result.safeZoneBBoxPt.minX, inToPt(0.25));
    assert.equal(result.safeZoneBBoxPt.maxX, inToPt(6) - inToPt(0.375));
  });

  // 30. RTL, even page -> inverted (inside=left)
  runCase('30. RTL even page -> inside=left', () => {
    const result = buildZones(
      { pageCount: 100, pageNumber: 6 },
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false, readingDirection: 'rtl' }
    );
    assert.equal(result.insideIsLeft, true);
    assert.equal(result.safeZoneBBoxPt.minX, inToPt(0.375));
    assert.equal(result.safeZoneBBoxPt.maxX, inToPt(6) - inToPt(0.25));
  });

  // --- 31-33. CHECKPOINT 5C: bleed horizontal resolution ---

  // 31. bleed=true, no readingDirection -> horizontal bleed stays unresolved
  runCase('31. bleed=true without readingDirection stays horizontally unresolved', () => {
    const result = buildZones({ pageCount: 100 }, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true });
    assert.equal(result.bleedHorizontalResolution, 'unresolved');
    assert.equal(result.bleedBoxPt.minX, null);
    assert.equal(result.bleedBoxPt.maxX, null);
    // Margin/LEM safe zone is UNAFFECTED by bleed being unresolved -- it
    // still gets the conservative treatment, independently.
    assert.equal(result.horizontalResolution, 'conservative');
    assert.notEqual(result.safeZoneBBoxPt.minX, null);
  });

  // 32. bleed=true WITH readingDirection -> horizontal bleed fully resolved
  runCase('32. bleed=true with readingDirection resolves horizontal bleed exactly', () => {
    const result = buildZones(
      { pageCount: 100, pageNumber: 5 },
      { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true, readingDirection: 'ltr' }
    );
    assert.equal(result.bleedHorizontalResolution, 'exact');
    assert.equal(result.insideIsLeft, true);
    assert.equal(result.bleedBoxPt.minX, 0 - inToPt(BLEED_INSIDE_IN)); // inside edge: 0 bleed
    assert.equal(result.bleedBoxPt.maxX, inToPt(6) + inToPt(0.125)); // outside edge: BLEED_OUTER_IN
    assert.ok(result.diagnostics.some((d) => d.code === 'BLEED_HORIZONTAL_RESOLVED_EXACT_ORIENTATION'));
  });

  // 33. conservative mode is NEVER applied to bleed, even when margins are
  // known and bleed=true but readingDirection is absent -- re-stated
  // explicitly as its own case per the explicit "DO NOT APPLY THIS TO
  // BLEED" instruction.
  runCase('33. conservative algorithm never reaches bleedBoxPt', () => {
    const result = buildZones({ pageCount: 700 }, { trimSize: { widthIn: 8.5, heightIn: 11 }, bleed: true });
    assert.equal(result.horizontalResolution, 'conservative');
    assert.equal(result.bleedHorizontalResolution, 'unresolved');
    assert.equal(result.bleedBoxPt.minX, null);
    assert.equal(result.bleedBoxPt.maxX, null);
  });

  console.log(`\nAll ${caseCount} zones-builder test cases passed.`);
}

main();
