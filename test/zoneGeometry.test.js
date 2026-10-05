'use strict';

/**
 * Unit tests for lib/zoneGeometry.js's buildZoneGeometry() -- the
 * isolated, NOT-production-wired coordinate-reference layer (2026-10-05
 * implementation checkpoint). Exactly the 18 cases requested, in the
 * same numbering.
 *
 * This file does NOT touch lib/zones.js, lib/margin.js, lib/autofix.js,
 * analyzePageObjects(), classifyViolations(), planAutofix(), or any
 * existing fixture. semanticZones inputs are built via the real,
 * unmodified lib/zones.js's buildZones(), so these tests also exercise
 * the real boundary between the two modules, not a mock of it.
 */

const assert = require('node:assert/strict');
const { buildZones, inToPt } = require('../lib/zones');
const { buildZoneGeometry } = require('../lib/zoneGeometry');

function pdfBox(x, y, widthPt, heightPt) {
  return { x, y, width: widthPt, height: heightPt };
}

const TRIM_6x9 = { widthIn: 6, heightIn: 9 };
const PAGE_COUNT_100 = 100; // inside=0.375in=27pt (24-150 row), any valid count works -- not the focus of this suite

let caseCount = 0;
function runCase(label, fn) {
  caseCount += 1;
  fn();
  console.log(`  [${caseCount}] ${label}: OK`);
}

function hasCode(diagnostics, code) {
  return diagnostics.some((d) => d.code === code);
}

function main() {
  // --- 1. consistent TrimBox with non-zero origin ---
  runCase('1. consistent TrimBox with non-zero origin', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(37, 52, inToPt(6), inToPt(9)) });
    assert.deepEqual(geo.trimBoxPt, { minX: 37, minY: 52, maxX: 37 + inToPt(6), maxY: 52 + inToPt(9) });
    assert.ok(hasCode(geo.diagnostics, 'TRIM_BOX_ANCHOR_USED'));
    assert.equal(geo.geometryStatus, 'partial');
    assert.equal(geo.complianceConfidence, 'high');
    assert.equal(geo.coordinateSystem.anchorSource, 'trimBox');
  });

  // --- 2. TrimBox width conflict ---
  runCase('2. TrimBox width conflict', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(5), inToPt(9)) }); // wrong width
    assert.ok(hasCode(geo.diagnostics, 'TRIM_BOX_WIDTH_CONFLICT'));
    assert.equal(geo.trimBoxPt, null);
    assert.equal(geo.geometryStatus, 'unavailable');
    assert.equal(geo.complianceConfidence, 'conflict');
  });

  // --- 3. TrimBox height conflict ---
  runCase('3. TrimBox height conflict', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(8)) }); // wrong height
    assert.ok(hasCode(geo.diagnostics, 'TRIM_BOX_HEIGHT_CONFLICT'));
    assert.equal(geo.trimBoxPt, null);
    assert.equal(geo.geometryStatus, 'unavailable');
    assert.equal(geo.complianceConfidence, 'conflict');
  });

  // --- 4. no TrimBox ---
  runCase('4. no TrimBox', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, {});
    assert.ok(hasCode(geo.diagnostics, 'NO_TRIM_BOX_ANCHOR'));
    assert.equal(geo.trimBoxPt, null);
    assert.equal(geo.geometryStatus, 'unavailable');
    assert.equal(geo.complianceConfidence, 'insufficient');
  });

  // --- 5. consistent BleedBox ---
  runCase('5. consistent BleedBox', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: true });
    const expectedBleedHeightPt = sz.bleedBoxPt.maxY - sz.bleedBoxPt.minY; // 666pt (648 + 2*9)
    const geo = buildZoneGeometry(sz, {
      trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)),
      bleedBox: pdfBox(-9, -9, inToPt(6) + 18, expectedBleedHeightPt), // width not validated, any value
    });
    assert.ok(hasCode(geo.diagnostics, 'BLEED_BOX_ANCHOR_USED'));
    assert.ok(hasCode(geo.diagnostics, 'BLEED_BOX_WIDTH_NOT_VALIDATED'));
    assert.deepEqual(geo.bleedBoxPt, { minX: -9, minY: -9, maxX: -9 + inToPt(6) + 18, maxY: -9 + expectedBleedHeightPt });
    assert.equal(geo.geometryStatus, 'partial');
    assert.equal(geo.complianceConfidence, 'high');
  });

  // --- 6. BleedBox conflict ---
  runCase('6. BleedBox conflict', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: true });
    const geo = buildZoneGeometry(sz, {
      trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)),
      bleedBox: pdfBox(0, 0, inToPt(6), inToPt(9) + 50), // wrong height
    });
    assert.ok(hasCode(geo.diagnostics, 'BLEED_BOX_HEIGHT_CONFLICT'));
    assert.equal(geo.bleedBoxPt, null);
    assert.equal(geo.geometryStatus, 'unavailable');
    assert.equal(geo.complianceConfidence, 'conflict');
  });

  // --- 7. no bleed ---
  runCase('7. no bleed', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)) });
    assert.equal(geo.bleedBoxPt, null);
    assert.ok(!hasCode(geo.diagnostics, 'NO_BLEED_BOX_ANCHOR'), 'no-bleed intent must not trigger a missing-bleed-box diagnostic');
    assert.equal(geo.geometryStatus, 'partial');
    assert.equal(geo.complianceConfidence, 'high');
    assert.equal(geo.source.bleed, 'none');
  });

  // --- 8. bleed=true but no BleedBox ---
  runCase('8. bleed=true but no BleedBox', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: true });
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)) }); // no bleedBox
    assert.ok(hasCode(geo.diagnostics, 'NO_BLEED_BOX_ANCHOR'));
    assert.equal(geo.bleedBoxPt, null);
    assert.equal(geo.geometryStatus, 'unavailable');
    assert.equal(geo.complianceConfidence, 'insufficient');
  });

  // --- 9. MediaBox only ---
  runCase('9. MediaBox only', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, { mediaBox: pdfBox(0, 0, inToPt(6.25), inToPt(9.25)) });
    assert.ok(hasCode(geo.diagnostics, 'MEDIA_BOX_PRESENT_NOT_USED_FOR_PLACEMENT'));
    assert.ok(hasCode(geo.diagnostics, 'NO_TRIM_BOX_ANCHOR'));
    assert.equal(geo.trimBoxPt, null, 'MediaBox must never be used to derive trim placement');
    assert.equal(geo.geometryStatus, 'unavailable');
  });

  // --- 10. MediaBox non-zero origin ---
  runCase('10. MediaBox non-zero origin', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, { mediaBox: pdfBox(100, 50, inToPt(6.25), inToPt(9.25)) });
    assert.equal(geo.trimBoxPt, null, "MediaBox's own non-zero origin must not leak into trim placement");
    assert.equal(geo.geometryStatus, 'unavailable');
  });

  // --- 11. TrimBox + MediaBox ---
  runCase('11. TrimBox + MediaBox', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, {
      mediaBox: pdfBox(0, 0, 450, 666), // different origin/size than trimBox -- must be ignored
      trimBox: pdfBox(9, 9, inToPt(6), inToPt(9)),
    });
    assert.ok(hasCode(geo.diagnostics, 'MEDIA_BOX_PRESENT_NOT_USED_FOR_PLACEMENT'));
    assert.ok(hasCode(geo.diagnostics, 'TRIM_BOX_ANCHOR_USED'));
    assert.deepEqual(geo.trimBoxPt, { minX: 9, minY: 9, maxX: 9 + inToPt(6), maxY: 9 + inToPt(9) }, 'trimBoxPt must come ONLY from TrimBox, independent of MediaBox');
  });

  // --- 12. CropBox present ---
  runCase('12. CropBox present', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, {
      trimBox: pdfBox(9, 9, inToPt(6), inToPt(9)),
      cropBox: pdfBox(0, 0, 450, 666),
    });
    assert.ok(hasCode(geo.diagnostics, 'CROP_BOX_PRESENT_UNUSED'));
    assert.deepEqual(geo.trimBoxPt, { minX: 9, minY: 9, maxX: 9 + inToPt(6), maxY: 9 + inToPt(9) }, 'CropBox must have zero effect on the result');
    assert.equal(geo.geometryStatus, 'partial');
  });

  // --- 13. safe-zone vertical geometry with valid TrimBox ---
  runCase('13. safe-zone vertical geometry with valid TrimBox', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false }); // topPt=bottomPt=18pt
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(37, 52, inToPt(6), inToPt(9)) });
    assert.equal(geo.safeZoneBBoxPt.minY, 52 + inToPt(0.25));
    assert.equal(geo.safeZoneBBoxPt.maxY, 52 + inToPt(9) - inToPt(0.25));
  });

  // --- 14. safe-zone horizontal unresolved ---
  runCase('14. safe-zone horizontal unresolved', () => {
    const noBleed = buildZoneGeometry(buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false }), { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)) });
    const withBleed = buildZoneGeometry(buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: true }), {
      trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)),
      bleedBox: pdfBox(-9, -9, 500, 666),
    });
    assert.equal(noBleed.safeZoneBBoxPt.minX, null);
    assert.equal(noBleed.safeZoneBBoxPt.maxX, null);
    assert.equal(withBleed.safeZoneBBoxPt.minX, null);
    assert.equal(withBleed.safeZoneBBoxPt.maxX, null);
    assert.ok(hasCode(noBleed.diagnostics, 'SAFE_ZONE_HORIZONTAL_EDGE_UNRESOLVED_WITHOUT_PAGE_PARITY'));
    assert.ok(hasCode(withBleed.diagnostics, 'SAFE_ZONE_HORIZONTAL_EDGE_UNRESOLVED_WITHOUT_PAGE_PARITY'));
  });

  // --- 15. partial geometry status ---
  runCase('15. partial geometry status', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)) });
    assert.equal(geo.geometryStatus, 'partial', "'complete' must be unreachable in this checkpoint -- safe-zone horizontal is always unresolved");
  });

  // --- 16. unavailable geometry status ---
  runCase('16. unavailable geometry status', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, {}); // no TrimBox at all
    assert.equal(geo.geometryStatus, 'unavailable');
  });

  // --- 17. non-zero rotation ---
  runCase('17. non-zero rotation', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)), rotationDeg: 90 });
    assert.ok(hasCode(geo.diagnostics, 'NON_ZERO_PAGE_ROTATION'));
    assert.equal(geo.coordinateSystem.rotationDeg, 90);
    // geometry itself must be untransformed/unchanged
    assert.deepEqual(geo.trimBoxPt, { minX: 0, minY: 0, maxX: inToPt(6), maxY: inToPt(9) });
  });

  // --- 18. rotation zero ---
  runCase('18. rotation zero', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const rotated = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)), rotationDeg: 90 });
    const unrotated = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)), rotationDeg: 0 });
    assert.ok(!hasCode(unrotated.diagnostics, 'NON_ZERO_PAGE_ROTATION'));
    assert.equal(unrotated.coordinateSystem.rotationDeg, 0);
    // same geometry regardless of rotationDeg -- confirms diagnostic-only, no transform
    assert.deepEqual(rotated.trimBoxPt, unrotated.trimBoxPt);
    assert.deepEqual(rotated.safeZoneBBoxPt, unrotated.safeZoneBBoxPt);
  });

  console.log(`\nAll ${caseCount} zoneGeometry test cases passed.`);
}

main();
