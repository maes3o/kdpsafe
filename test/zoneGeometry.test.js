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
  // CHECKPOINT 5C (2026-10-05): updated. Previously this gave up on bleed
  // geometry entirely (NO_BLEED_BOX_ANCHOR, bleedBoxPt=null,
  // geometryStatus='unavailable'). Now it falls back to the SAME
  // anchorless construction pattern already used for safeZoneBBoxPt:
  // offset lib/zones.js's own, already-computed bleedBoxPt (vertical
  // always known) into the real trimBoxPt frame. Without readingDirection,
  // its horizontal axis stays null -- bleedBoxPt is "present but
  // horizontally unresolved", not absent. geometryStatus becomes
  // 'partial' (genuine vertical bleed geometry exists now), not
  // 'unavailable'.
  runCase('8. bleed=true but no BleedBox falls back to anchorless vertical-only bleed', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: true });
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)) }); // no bleedBox
    assert.ok(hasCode(geo.diagnostics, 'BLEED_BOX_ANCHORLESS_FROM_SEMANTIC_ZONES'));
    assert.ok(!hasCode(geo.diagnostics, 'NO_BLEED_BOX_ANCHOR'));
    assert.notEqual(geo.bleedBoxPt, null, 'bleedBoxPt is now present (vertical-only) rather than absent entirely');
    assert.equal(geo.bleedBoxPt.minX, null, 'horizontal axis still null without readingDirection');
    assert.equal(geo.bleedBoxPt.maxX, null);
    assert.equal(geo.bleedBoxPt.minY, 0 - inToPt(0.125));
    assert.equal(geo.bleedBoxPt.maxY, inToPt(9) + inToPt(0.125));
    assert.equal(geo.geometryStatus, 'partial', 'genuine (vertical-only) bleed geometry is not the same as unavailable');
    assert.equal(geo.complianceConfidence, 'high', 'no conflict and nothing missing that a conflict/insufficient label would apply to');
  });

  // --- 8b. CHECKPOINT 5C safety regression: a present-but-horizontally-
  // null bleedBoxPt must still correctly BLOCK left/right in
  // lib/orchestrator.js's resolveAllowedSides() -- the exact gap this
  // fallback is designed to close (a bare `bleedBoxPt === null` would
  // vacuously PASS that gate instead).
  runCase('8b. anchorless vertical-only bleedBoxPt still blocks left/right via resolveAllowedSides', () => {
    const { resolveAllowedSides } = require('../lib/orchestrator');
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: true });
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)) });
    const allowed = resolveAllowedSides(geo);
    assert.equal(allowed.left, false, 'left must stay blocked -- bleed=true horizontal bleed is still unresolved');
    assert.equal(allowed.right, false, 'right must stay blocked for the same reason');
    assert.equal(allowed.top, true, 'top is unaffected (vertical bleed/margins are fully resolved)');
    assert.equal(allowed.bottom, true);
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

  // --- 14. safe-zone horizontal: conservative resolution (not null) ---
  // CHECKPOINT 5C (2026-10-05): updated. Margin/LEM safe-zone horizontal
  // resolution is now INDEPENDENT of bleed -- both cases get the
  // conservative, orientation-independent zone (CHECKPOINT 5A), since
  // insidePt/outsidePt are known in both. Bleed's OWN horizontal axis is
  // a separate matter (see case 8/8b/31-33 in zones-builder.test.js) and
  // is NOT what this case is about.
  runCase('14. safe-zone horizontal resolves conservatively regardless of bleed', () => {
    const noBleed = buildZoneGeometry(buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false }), { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)) });
    const withBleed = buildZoneGeometry(buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: true }), {
      trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)),
      bleedBox: pdfBox(-9, -9, 500, 666),
    });
    const conservativeMarginPt = inToPt(0.375); // max(insidePt=0.375in, outsidePt=0.25in) for pageCount=100
    assert.equal(noBleed.safeZoneBBoxPt.minX, conservativeMarginPt);
    assert.equal(noBleed.safeZoneBBoxPt.maxX, inToPt(6) - conservativeMarginPt);
    assert.equal(withBleed.safeZoneBBoxPt.minX, conservativeMarginPt);
    assert.equal(withBleed.safeZoneBBoxPt.maxX, inToPt(6) - conservativeMarginPt);
    assert.ok(hasCode(noBleed.diagnostics, 'SAFE_ZONE_HORIZONTAL_CONSERVATIVE_ORIENTATION_INDEPENDENT'));
    assert.ok(hasCode(withBleed.diagnostics, 'SAFE_ZONE_HORIZONTAL_CONSERVATIVE_ORIENTATION_INDEPENDENT'));
    assert.deepEqual(noBleed.orientationHypotheses, {
      ltr: { minX: inToPt(0.375), maxX: inToPt(6) - inToPt(0.25) },
      rtl: { minX: inToPt(0.25), maxX: inToPt(6) - inToPt(0.375) },
    });
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
  // UPDATED (page-geometry V2 false-READY fix): rotation used to be
  // "diagnostic only, geometry untransformed", which let a page displayed
  // at 9x6in pass as 6x9. A rotated page now has UNAVAILABLE geometry.
  runCase('17. non-zero rotation -> geometry unavailable (never anchored on raw boxes)', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)), rotationDeg: 90 });
    assert.ok(hasCode(geo.diagnostics, 'PAGE_ROTATION_UNSUPPORTED'));
    assert.equal(geo.coordinateSystem.rotationDeg, 90);
    assert.equal(geo.geometryStatus, 'unavailable');
    assert.equal(geo.trimBoxPt, null);
    assert.equal(geo.safeZoneBBoxPt, null);
    for (const deg of [180, 270, -90]) {
      const g = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)), rotationDeg: deg });
      assert.equal(g.geometryStatus, 'unavailable', `rotation ${deg}`);
    }
  });

  // --- 18. rotation zero / 360 ---
  runCase('18. rotation zero (and 360) keeps the normal geometry', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const unrotated = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)), rotationDeg: 0 });
    assert.ok(!hasCode(unrotated.diagnostics, 'PAGE_ROTATION_UNSUPPORTED'));
    assert.equal(unrotated.coordinateSystem.rotationDeg, 0);
    assert.notEqual(unrotated.geometryStatus, 'unavailable');
    const full = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)), rotationDeg: 360 });
    assert.deepEqual(full.trimBoxPt, unrotated.trimBoxPt);
  });

  // --- 19-21. CHECKPOINT 5C: exact orientation -> geometryStatus 'complete' ---

  // 19. exact orientation, bleed=false, everything else resolved -> 'complete'
  runCase('19. exact orientation + no bleed -> geometryStatus complete', () => {
    const sz = buildZones(
      { pageCount: PAGE_COUNT_100, pageNumber: 5 },
      { trimSize: TRIM_6x9, bleed: false, readingDirection: 'ltr' }
    );
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)) });
    assert.equal(geo.horizontalResolution, 'exact');
    assert.equal(geo.safeZoneBBoxPt.minX, inToPt(0.375));
    assert.equal(geo.safeZoneBBoxPt.maxX, inToPt(6) - inToPt(0.25));
    assert.equal(geo.geometryStatus, 'complete', "'complete' is reachable now, specifically under exact orientation resolution");
    assert.equal(geo.orientationHypotheses, null, 'exact mode carries no hypotheses -- there is nothing ambiguous left to resolve');
  });

  // 20. exact orientation + bleed=true, bleed anchorless (no real
  // /BleedBox) -> bleed resolves exactly too via the semantic fallback ->
  // still 'complete'.
  runCase('20. exact orientation + bleed=true (anchorless) -> geometryStatus complete', () => {
    const sz = buildZones(
      { pageCount: PAGE_COUNT_100, pageNumber: 6 },
      { trimSize: TRIM_6x9, bleed: true, readingDirection: 'ltr' }
    );
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)) }); // no explicit BleedBox
    assert.equal(geo.horizontalResolution, 'exact');
    assert.notEqual(geo.bleedBoxPt.minX, null);
    assert.notEqual(geo.bleedBoxPt.maxX, null);
    assert.equal(geo.geometryStatus, 'complete');
  });

  // 21. conservative mode (no readingDirection) must NEVER reach
  // 'complete', even with everything else perfectly resolved -- the
  // explicit distinction CHECKPOINT 5A/5B insisted on (conservative is
  // proven safe for READY, but is not the same claim as "fully resolved").
  runCase('21. conservative mode never reaches geometryStatus complete', () => {
    const sz = buildZones({ pageCount: PAGE_COUNT_100 }, { trimSize: TRIM_6x9, bleed: false });
    const geo = buildZoneGeometry(sz, { trimBox: pdfBox(0, 0, inToPt(6), inToPt(9)) });
    assert.equal(geo.horizontalResolution, 'conservative');
    assert.equal(geo.geometryStatus, 'partial');
  });

  console.log(`\nAll ${caseCount} zoneGeometry test cases passed.`);
}

main();
