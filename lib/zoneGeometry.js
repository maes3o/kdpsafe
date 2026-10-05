'use strict';

/**
 * Coordinate-reference layer for KDPSafe zones (2026-10-05 implementation
 * checkpoint, built on the "Architecture review after d13e014" and
 * "DESIGN ONLY for geometry adapter" checkpoints from this session).
 *
 * This module is the ONE missing piece between lib/zones.js's abstract,
 * origin-anchored semantic zones and the raw PDF user-space coordinate
 * system that lib/margin.js's analyzePageObjects() already returns object
 * bboxes in (confirmed empirically, checkpoint 7b1642d). It is NOT wired
 * into analyzePageObjects(), classifyViolations(), planAutofix(), or
 * planAutofixForPage() -- those remain completely untouched, as does
 * lib/zones.js itself.
 *
 * RESPONSIBILITY, PRECISELY:
 *   semantic zones (lib/zones.js's output: marginsPt + intent)
 *     + real PDF page boxes (coordinate reference: TrimBox/BleedBox, if
 *       present in the actual file)
 *   -> geometric zones in the SAME raw PDF user-space analyzePageObjects()
 *      uses.
 *
 * This module does NOT decide KDP policy, does NOT determine trim/bleed
 * intent (that's lib/zones.js's job, already done by the time its output
 * reaches here), does NOT know any KDP-specific number (0.125in bleed,
 * 0.25in/0.375in margin, the page-count gutter table -- none of those
 * constants are defined or re-derived here; wherever a KDP-specific
 * expected value is needed for a consistency check, it is read from
 * lib/zones.js's ALREADY-COMPUTED output, never recomputed), and does not
 * guess page parity / binding edge / reading direction. Where horizontal
 * (inside vs. outside / gutter) placement cannot be determined without
 * that missing information, this module leaves it explicitly unresolved
 * (`null`) rather than inventing a placement -- see
 * SAFE_ZONE_HORIZONTAL_EDGE_UNRESOLVED_WITHOUT_PAGE_PARITY below.
 *
 * ---------------------------------------------------------------------
 * KEY INSIGHT that shapes this design (see the preceding design
 * checkpoint for the full reasoning): a REAL, EXPLICIT PDF box
 * (/TrimBox, /BleedBox) is direct recorded coordinate evidence -- using
 * it, once confirmed consistent, is NOT subject to the inside/outside
 * parity ambiguity at all, because its left and right edges are already
 * physically fixed in the file; there is nothing to "decide". The parity
 * ambiguity ONLY arises when geometry must be DERIVED from semantic
 * {insidePt, outsidePt} margins without any real box to anchor to -- and
 * that is exactly, and only, lib/zones.js's safeZoneBBoxPt's situation,
 * because there is no PDF dictionary entry for a "safe zone" to read in
 * the first place. So: trimBoxPt and bleedBoxPt CAN reach a fully
 * resolved 4-number box (when real, consistent evidence exists);
 * safeZoneBBoxPt's horizontal extent CANNOT, in this checkpoint, by
 * design (no pageParity/bindingEdge/Option C implemented here).
 */

const { TOLERANCE_PT } = require('./margin');
const { inToPt } = require('./zones');

function dims(box) {
  return { widthPt: box.width, heightPt: box.height };
}

function approxEqual(a, b, epsilon) {
  return Math.abs(a - b) <= epsilon;
}

function toMinMaxBox(pdfLibBox) {
  return { minX: pdfLibBox.x, minY: pdfLibBox.y, maxX: pdfLibBox.x + pdfLibBox.width, maxY: pdfLibBox.y + pdfLibBox.height };
}

/**
 * Resolves trimBoxPt from a real, explicit /TrimBox, iff present AND its
 * dimensions match the user-confirmed trim size from semanticZones.intent
 * (within the project's existing TOLERANCE_PT) -- the expected dimensions
 * here come directly from the user's own trimSize input (a unit
 * conversion, not a KDP rule), so comparing against them is not "KDP
 * policy knowledge".
 */
function resolveTrimBoxPt(pdfBoxes, expectedTrimDimsPt, diagnostics) {
  const trimBox = pdfBoxes.trimBox;
  if (!trimBox) {
    diagnostics.push({
      code: 'NO_TRIM_BOX_ANCHOR',
      message: 'Явний /TrimBox відсутній у pdfBoxes -- немає реального coordinate reference для розміщення trim-геометрії; placement не вгадується.',
    });
    return { trimBoxPt: null, status: 'unavailable', conflict: false };
  }

  const actual = dims(trimBox);
  const widthOk = approxEqual(actual.widthPt, expectedTrimDimsPt.widthPt, TOLERANCE_PT);
  const heightOk = approxEqual(actual.heightPt, expectedTrimDimsPt.heightPt, TOLERANCE_PT);

  if (!widthOk) {
    diagnostics.push({
      code: 'TRIM_BOX_WIDTH_CONFLICT',
      message: `Ширина явного /TrimBox (${actual.widthPt}pt) не відповідає підтвердженому trim size (${expectedTrimDimsPt.widthPt}pt) -- TrimBox не використовується як coordinate anchor.`,
    });
  }
  if (!heightOk) {
    diagnostics.push({
      code: 'TRIM_BOX_HEIGHT_CONFLICT',
      message: `Висота явного /TrimBox (${actual.heightPt}pt) не відповідає підтвердженому trim size (${expectedTrimDimsPt.heightPt}pt) -- TrimBox не використовується як coordinate anchor.`,
    });
  }

  if (!widthOk || !heightOk) {
    return { trimBoxPt: null, status: 'unavailable', conflict: true };
  }

  diagnostics.push({ code: 'TRIM_BOX_ANCHOR_USED', message: 'Явний /TrimBox узгоджується з trim size і використаний як coordinate anchor для trimBoxPt.' });
  return { trimBoxPt: toMinMaxBox(trimBox), status: 'resolved', conflict: false };
}

/**
 * Resolves bleedBoxPt from a real, explicit /BleedBox, iff present AND
 * its HEIGHT matches the height semanticZones.bleedBoxPt already
 * resolved (lib/zones.js computes this deterministically, since top+
 * bottom bleed are never gutter-side-dependent -- see its own module
 * header). WIDTH is deliberately NOT independently validated here: this
 * module does not know (and must not re-derive) the KDP outer-bleed
 * amount, and lib/zones.js itself never resolves an expected bleed WIDTH
 * (its own bleedBoxPt.minX/maxX are null, for the same inside/outside
 * reason) -- there is no non-duplicating value to check it against. This
 * is an explicit, documented limitation (see the final report), not an
 * oversight.
 */
function resolveBleedBoxPt(pdfBoxes, semanticZones, diagnostics) {
  const bleedBox = pdfBoxes.bleedBox;
  if (!bleedBox) {
    diagnostics.push({
      code: 'NO_BLEED_BOX_ANCHOR',
      message: 'bleed=true, але явний /BleedBox відсутній у pdfBoxes -- немає реального coordinate reference для bleed-геометрії; placement не вгадується.',
    });
    return { bleedBoxPt: null, status: 'unavailable', conflict: false };
  }

  const expectedHeightPt = semanticZones.bleedBoxPt ? semanticZones.bleedBoxPt.maxY - semanticZones.bleedBoxPt.minY : null;
  const actual = dims(bleedBox);

  if (expectedHeightPt === null) {
    // Should not happen when intent.bleed === true and lib/zones.js ran
    // successfully, but fails safe rather than assuming a value.
    diagnostics.push({ code: 'BLEED_BOX_EXPECTED_HEIGHT_UNAVAILABLE', message: 'Очікувана висота bleed-геометрії не була надана semanticZones -- консистентність /BleedBox перевірити неможливо.' });
    return { bleedBoxPt: null, status: 'unavailable', conflict: false };
  }

  const heightOk = approxEqual(actual.heightPt, expectedHeightPt, TOLERANCE_PT);
  if (!heightOk) {
    diagnostics.push({
      code: 'BLEED_BOX_HEIGHT_CONFLICT',
      message: `Висота явного /BleedBox (${actual.heightPt}pt) не відповідає висоті, уже обчисленій semanticZones (${expectedHeightPt}pt) -- BleedBox не використовується як coordinate anchor.`,
    });
    return { bleedBoxPt: null, status: 'unavailable', conflict: true };
  }

  diagnostics.push({
    code: 'BLEED_BOX_ANCHOR_USED',
    message: 'Висота явного /BleedBox узгоджується з уже обчисленою semanticZones-геометрією і використана як coordinate anchor для bleedBoxPt. Примітка: ширина /BleedBox НЕ перевіряється цим модулем окремо -- див. BLEED_BOX_WIDTH_NOT_VALIDATED.',
  });
  diagnostics.push({
    code: 'BLEED_BOX_WIDTH_NOT_VALIDATED',
    message: 'zoneGeometry.js не перевіряє ширину /BleedBox незалежно: очікувана ширина залежить від KDP-специфічного bleed-значення, яке цей модуль свідомо не зберігає (щоб не дублювати policy з lib/zones.js), а lib/zones.js також не надає вирішеної очікуваної ширини (через ту саму inside/outside-блокуючу причину). Реальна ширина /BleedBox використовується як є.',
  });
  return { bleedBoxPt: toMinMaxBox(bleedBox), status: 'resolved', conflict: false };
}

/**
 * buildZoneGeometry(semanticZones, pdfBoxes) -> see module header / final
 * report for the full result-contract rationale.
 *
 * semanticZones: the object lib/zones.js's buildZones() returns. Only
 * `marginsPt` and `intent` are read -- no other field of it is consumed.
 * pdfBoxes: { mediaBox?, cropBox?, trimBox?, bleedBox?, rotationDeg? },
 *   each box (if present) in pdf-lib's {x,y,width,height} shape.
 */
function buildZoneGeometry(semanticZones, pdfBoxes) {
  const diagnostics = [];
  const sz = semanticZones || {};
  const boxes = pdfBoxes || {};
  const intent = sz.intent || {};

  if (!intent.trimSize || typeof intent.trimSize.widthIn !== 'number' || typeof intent.trimSize.heightIn !== 'number') {
    diagnostics.push({ code: 'TRIM_SIZE_MISSING', message: 'semanticZones.intent.trimSize відсутній -- geometry побудувати неможливо.' });
    return {
      trimBoxPt: null,
      bleedBoxPt: null,
      safeZoneBBoxPt: null,
      coordinateSystem: { anchorSource: 'none', rotationDeg: boxes.rotationDeg ?? 0 },
      geometryStatus: 'unavailable',
      complianceConfidence: 'insufficient',
      source: { trim: 'none', bleed: 'none', margins: sz.sources ? sz.sources.margins : 'kdp' },
      diagnostics,
    };
  }
  if (typeof intent.bleed !== 'boolean') {
    diagnostics.push({ code: 'BLEED_INTENT_MISSING', message: 'semanticZones.intent.bleed відсутній -- bleed-геометрію побудувати неможливо.' });
    return {
      trimBoxPt: null,
      bleedBoxPt: null,
      safeZoneBBoxPt: null,
      coordinateSystem: { anchorSource: 'none', rotationDeg: boxes.rotationDeg ?? 0 },
      geometryStatus: 'unavailable',
      complianceConfidence: 'insufficient',
      source: { trim: 'none', bleed: 'none', margins: sz.sources ? sz.sources.margins : 'kdp' },
      diagnostics,
    };
  }

  const expectedTrimDimsPt = { widthPt: inToPt(intent.trimSize.widthIn), heightPt: inToPt(intent.trimSize.heightIn) };

  if (boxes.mediaBox) {
    diagnostics.push({ code: 'MEDIA_BOX_PRESENT_NOT_USED_FOR_PLACEMENT', message: 'MediaBox присутній, але НЕ використовується як coordinate reference чи intent -- лише TrimBox/BleedBox (коли явно присутні й узгоджені) можуть бути anchor.' });
  }
  if (boxes.cropBox) {
    diagnostics.push({ code: 'CROP_BOX_PRESENT_UNUSED', message: 'CropBox присутній, але не використовується цим модулем (diagnostic-only/unused, як і в lib/zones.js).' });
  }

  // --- Trim ---
  const trimResolution = resolveTrimBoxPt(boxes, expectedTrimDimsPt, diagnostics);
  const trimBoxPt = trimResolution.trimBoxPt;

  // --- Bleed ---
  let bleedBoxPt = null;
  let bleedResolution = { status: 'not-applicable', conflict: false };
  if (intent.bleed === false) {
    bleedBoxPt = null; // per explicit instruction: unconditional, no further checks
  } else {
    bleedResolution = resolveBleedBoxPt(boxes, sz, diagnostics);
    bleedBoxPt = bleedResolution.bleedBoxPt;
  }

  // --- Safe zone: vertical extent only needs the trim anchor's Y
  // position + marginsPt.top/bottomPt (already-resolved semantic
  // values, not recomputed here). Horizontal extent is explicitly left
  // unresolved -- no pageParity/bindingEdge/Option C in this checkpoint.
  let safeZoneBBoxPt = null;
  if (trimBoxPt && sz.marginsPt && typeof sz.marginsPt.topPt === 'number' && typeof sz.marginsPt.bottomPt === 'number') {
    safeZoneBBoxPt = {
      minX: null,
      minY: trimBoxPt.minY + sz.marginsPt.bottomPt,
      maxX: null,
      maxY: trimBoxPt.maxY - sz.marginsPt.topPt,
    };
    diagnostics.push({
      code: 'SAFE_ZONE_HORIZONTAL_EDGE_UNRESOLVED_WITHOUT_PAGE_PARITY',
      message: 'safeZoneBBoxPt.minX/maxX залишені null: inside/outside LEM-межі асиметричні відносно лівого/правого краю, а page parity ніде не визначена у цьому checkpoint -- горизонтальна вісь не вгадується.',
    });
  } else {
    diagnostics.push({
      code: 'SAFE_ZONE_UNAVAILABLE_WITHOUT_TRIM_ANCHOR',
      message: 'safeZoneBBoxPt не може бути побудований навіть по вертикалі без відомого trim coordinate anchor.',
    });
  }

  // --- Rotation: diagnostic metadata only, no transform ---
  const rotationDeg = boxes.rotationDeg ?? 0;
  if (rotationDeg !== 0) {
    diagnostics.push({
      code: 'NON_ZERO_PAGE_ROTATION',
      message: `pdfBoxes.rotationDeg=${rotationDeg}. Геометрія вище залишається у raw/unrotated PDF user-space -- жодної трансформації координат не виконано.`,
    });
  }

  // --- geometryStatus rollup ---
  // 'complete' is intentionally unreachable in this checkpoint:
  // safeZoneBBoxPt's horizontal axis is always unresolved here (no
  // pageParity/bindingEdge/Option C implemented), so the best reachable
  // status is 'partial'. 'unavailable' when even trim (or bleed, when
  // required) couldn't be anchored at all.
  let geometryStatus;
  const trimOk = trimResolution.status === 'resolved';
  const bleedOk = intent.bleed === false || bleedResolution.status === 'resolved';
  if (!trimOk || !bleedOk) {
    geometryStatus = 'unavailable';
  } else {
    geometryStatus = 'partial'; // safe-zone horizontal axis always unresolved in this checkpoint
  }

  // --- complianceConfidence rollup ---
  const hasConflict = trimResolution.conflict || bleedResolution.conflict;
  let complianceConfidence;
  if (hasConflict) {
    complianceConfidence = 'conflict';
  } else if (!trimOk || !bleedOk) {
    complianceConfidence = 'insufficient';
  } else {
    complianceConfidence = 'high';
  }

  let anchorSource = 'none';
  if (trimOk && bleedOk && intent.bleed) anchorSource = 'trimBox+bleedBox';
  else if (trimOk) anchorSource = 'trimBox';

  return {
    trimBoxPt,
    bleedBoxPt,
    safeZoneBBoxPt,
    coordinateSystem: { anchorSource, rotationDeg },
    geometryStatus,
    complianceConfidence,
    source: {
      trim: trimOk ? 'trimBox-anchored' : 'none',
      bleed: intent.bleed === false ? 'none' : bleedOk ? 'bleedBox-anchored' : 'none',
      margins: sz.sources ? sz.sources.margins : 'kdp',
    },
    diagnostics,
  };
}

module.exports = {
  buildZoneGeometry,
};
