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
 * CHECKPOINT 5C (2026-10-05): offsets a box already expressed in
 * lib/zones.js's ABSTRACT, origin-anchored frame (its own trimBoxPt is
 * always {minX:0,minY:0,...}) into THIS module's REAL, PDF-anchored frame
 * -- i.e. the frame the real, resolved `trimBoxPt` argument here lives in.
 * Because the abstract frame's origin is always (0,0), the real coordinate
 * for any abstract value V along an axis is simply
 * `realTrimOrigin + V` -- the exact same arithmetic this module already
 * used (pre-5C) for safeZoneBBoxPt's vertical axis
 * (`trimBoxPt.minY + sz.marginsPt.bottomPt`, where
 * `sz.marginsPt.bottomPt === sz.safeZoneBBoxPt.minY - 0`). Generalized here
 * so the same, single formula also covers the now-resolvable horizontal
 * axis (safeZoneBBoxPt, orientationHypotheses, and -- via the anchor-less
 * bleed fallback below -- bleedBoxPt), without re-deriving or duplicating
 * any KDP-specific number: every value offset here was already fully
 * computed by lib/zones.js.
 *
 * `null`/`undefined` on any axis passes through as `null` (still
 * UNKNOWN, never coerced into an offset of 0 -- CHECKPOINT 2's own rule).
 */
function offsetFromAbstract(trimBoxPt, abstractBox) {
  if (!abstractBox) return null;
  const off = (v, originReal) => (typeof v === 'number' && Number.isFinite(v) ? originReal + v : null);
  return {
    minX: off(abstractBox.minX, trimBoxPt.minX),
    minY: off(abstractBox.minY, trimBoxPt.minY),
    maxX: off(abstractBox.maxX, trimBoxPt.minX),
    maxY: off(abstractBox.maxY, trimBoxPt.minY),
  };
}

/** Same idea, but for a bare {minX,maxX} hypothesis box (no Y axis). */
function offsetHypothesisFromAbstract(trimBoxPt, hyp) {
  if (!hyp) return { minX: null, maxX: null };
  const off = (v) => (typeof v === 'number' && Number.isFinite(v) ? trimBoxPt.minX + v : null);
  return { minX: off(hyp.minX), maxX: off(hyp.maxX) };
}

/** Offsets lib/zones.js's {ltr,rtl} orientationHypotheses pair as a whole. */
function offsetHypothesesPair(trimBoxPt, hypotheses) {
  if (!hypotheses) return null;
  return {
    ltr: offsetHypothesisFromAbstract(trimBoxPt, hypotheses.ltr),
    rtl: offsetHypothesisFromAbstract(trimBoxPt, hypotheses.rtl),
  };
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
function resolveBleedBoxPt(pdfBoxes, semanticZones, trimBoxPt, diagnostics) {
  const bleedBox = pdfBoxes.bleedBox;
  if (!bleedBox) {
    // CHECKPOINT 5C (2026-10-05): no explicit /BleedBox anchor in the
    // file -- rather than giving up on bleed geometry entirely (the
    // pre-5C behavior), fall back to the SAME anchor-less construction
    // pattern already used for safeZoneBBoxPt: offset
    // semanticZones.bleedBoxPt (lib/zones.js's own, ALREADY fully
    // computed bleedBoxPt -- vertical always, horizontal only when
    // 'exact' orientation resolution applied there) into this trimBoxPt's
    // real coordinate frame. This module still does not know or re-derive
    // any KDP-specific bleed constant -- it only offsets a value
    // lib/zones.js already computed, exactly like it already did for
    // safeZoneBBoxPt's vertical axis.
    //
    // CRITICAL SAFETY NOTE: when semanticZones.bleedBoxPt's horizontal
    // axis is itself unresolved (readingDirection not given --
    // conservative treatment is deliberately NEVER applied to bleed, see
    // lib/zones.js's own header / CHECKPOINT 5A §5), the offset of `null`
    // stays `null` -- the returned bleedBoxPt is "present but with
    // null horizontal edges", which is exactly the shape
    // lib/orchestrator.js's resolveAllowedSides() already requires to
    // correctly block left/right (a bare `bleedBoxPt === null` would
    // instead vacuously PASS that gate -- the real bug this fallback
    // exists to prevent; see the CHECKPOINT 5C implementation report).
    if (!trimBoxPt || !semanticZones.bleedBoxPt) {
      diagnostics.push({
        code: 'NO_BLEED_BOX_ANCHOR',
        message: 'bleed=true, але явний /BleedBox відсутній у pdfBoxes, а trimBoxPt і/або semanticZones.bleedBoxPt також недоступні -- bleed-геометрію побудувати неможливо жодним способом.',
      });
      return { bleedBoxPt: null, status: 'unavailable', conflict: false };
    }
    diagnostics.push({
      code: 'BLEED_BOX_ANCHORLESS_FROM_SEMANTIC_ZONES',
      message:
        'Явний /BleedBox відсутній у pdfBoxes -- bleedBoxPt побудований без PDF-анкера, офсетом уже обчисленого semanticZones.bleedBoxPt у реальну систему координат trimBoxPt (той самий anchorless-підхід, що й для safeZoneBBoxPt). Горизонтальна вісь лишається null, якщо readingDirection не задано -- conservative-підхід до bleed свідомо не застосовується.',
    });
    const bleedBoxPt = offsetFromAbstract(trimBoxPt, semanticZones.bleedBoxPt);
    // Three-state status (CHECKPOINT 5C): 'resolved' only when BOTH axes
    // are real numbers (horizontal needed readingDirection); 'partial'
    // when only the (always-deterministic) vertical axis is -- still
    // genuine, usable geometry, just not enough for geometryStatus
    // 'complete'; resolveAllowedSides() itself doesn't read this status
    // string at all, it inspects bleedBoxPt's actual edge values, so a
    // 'partial' bleedBoxPt here still correctly blocks left/right there.
    const horizontalOk = bleedBoxPt.minX !== null && bleedBoxPt.maxX !== null;
    return { bleedBoxPt, status: horizontalOk ? 'resolved' : 'partial', conflict: false };
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
      horizontalResolution: 'unresolved',
      orientationHypotheses: null,
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
      horizontalResolution: 'unresolved',
      orientationHypotheses: null,
      coordinateSystem: { anchorSource: 'none', rotationDeg: boxes.rotationDeg ?? 0 },
      geometryStatus: 'unavailable',
      complianceConfidence: 'insufficient',
      source: { trim: 'none', bleed: 'none', margins: sz.sources ? sz.sources.margins : 'kdp' },
      diagnostics,
    };
  }

  // FALSE-READY FIX (page-geometry V2): a page with /Rotate != 0 is DISPLAYED
  // (and printed) with its width/height swapped (90/270) or flipped (180)
  // relative to the raw boxes this module compares against the user's trim
  // size. Treating rotation as harmless metadata let a 432x648 page with
  // /Rotate 90 -- visibly 9x6in landscape -- pass as a "6x9" READY page.
  // Rotation is not transformed here (no coordinate mapping is attempted):
  // the page's geometry is declared UNAVAILABLE, so the safety gate blocks
  // every side and the document can never reach READY on rotated pages.
  const rotationRaw = boxes.rotationDeg ?? 0;
  const rotationNorm = ((Math.round(rotationRaw) % 360) + 360) % 360;
  if (rotationNorm !== 0) {
    diagnostics.push({
      code: 'PAGE_ROTATION_UNSUPPORTED',
      message: `Сторінка має /Rotate=${rotationRaw}°: ефективний (відображуваний) розмір і система координат відрізняються від сирих боксів, тому trim-геометрію побудувати безпечно неможливо -- сторінка не може отримати READY.`,
    });
    return {
      trimBoxPt: null,
      bleedBoxPt: null,
      safeZoneBBoxPt: null,
      horizontalResolution: 'unresolved',
      orientationHypotheses: null,
      coordinateSystem: { anchorSource: 'none', rotationDeg: rotationRaw },
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
    bleedResolution = resolveBleedBoxPt(boxes, sz, trimBoxPt, diagnostics);
    bleedBoxPt = bleedResolution.bleedBoxPt;
  }

  // --- Safe zone (CHECKPOINT 5C, 2026-10-05): vertical extent only needs
  // the trim anchor's Y position + marginsPt.top/bottomPt, exactly as
  // before. Horizontal extent now follows sz.horizontalResolution --
  // offset via offsetFromAbstract() rather than recomputed, so this
  // module never re-derives or duplicates any KDP-specific number;
  // everything here was already fully computed by lib/zones.js. ---
  let safeZoneBBoxPt = null;
  let orientationHypotheses = null;
  if (trimBoxPt && sz.marginsPt && typeof sz.marginsPt.topPt === 'number' && typeof sz.marginsPt.bottomPt === 'number') {
    const horizontal = sz.safeZoneBBoxPt
      ? { minX: sz.safeZoneBBoxPt.minX, maxX: sz.safeZoneBBoxPt.maxX }
      : { minX: null, maxX: null };
    const offsetHorizontal = offsetHypothesisFromAbstract(trimBoxPt, horizontal);
    safeZoneBBoxPt = {
      minX: offsetHorizontal.minX,
      minY: trimBoxPt.minY + sz.marginsPt.bottomPt,
      maxX: offsetHorizontal.maxX,
      maxY: trimBoxPt.maxY - sz.marginsPt.topPt,
    };
    orientationHypotheses = offsetHypothesesPair(trimBoxPt, sz.orientationHypotheses);

    if (sz.horizontalResolution === 'exact') {
      diagnostics.push({
        code: 'SAFE_ZONE_HORIZONTAL_RESOLVED_EXACT_ORIENTATION',
        message: 'safeZoneBBoxPt горизонтально повністю й точно визначений (offset lib/zones.js-ового exact-результату) -- readingDirection+pageNumber були надані.',
      });
    } else if (sz.horizontalResolution === 'conservative') {
      diagnostics.push({
        code: 'SAFE_ZONE_HORIZONTAL_CONSERVATIVE_ORIENTATION_INDEPENDENT',
        message: 'safeZoneBBoxPt горизонтально побудований як conservative orientation-independent intersection (offset lib/zones.js-ового conservative-результату) -- readingDirection не надано. Див. orientationHypotheses для L/R-гіпотез, потрібних для розрізнення AMBIGUOUS від definite violation (CHECKPOINT 5B).',
      });
    } else {
      diagnostics.push({
        code: 'SAFE_ZONE_HORIZONTAL_EDGE_UNRESOLVED_WITHOUT_PAGE_PARITY',
        message: 'safeZoneBBoxPt.minX/maxX залишені null: insidePt/outsidePt самі недоступні (pageCount-проблема) -- навіть conservative зона не може бути побудована.',
      });
    }
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

  // --- geometryStatus rollup (CHECKPOINT 5C, 2026-10-05) ---
  // 'complete' is now reachable, specifically and only, when EVERY
  // requirement resolves EXACTLY (not merely conservatively): trim
  // anchored, bleed either not required or fully resolved on both axes,
  // AND safeZoneBBoxPt's horizontal axis came from 'exact' orientation
  // resolution (readingDirection+pageNumber), never from the
  // 'conservative' intersection -- the conservative zone is proven safe
  // for READY (CHECKPOINT 5A) but is NOT the same claim as "fully,
  // unambiguously resolved geometry", which is what 'complete' has always
  // meant since CHECKPOINT 2/3. 'partial' covers both the pre-5C ceiling
  // AND the new conservative-but-not-exact case. 'unavailable' only when
  // trim, or bleed when it's required, couldn't be anchored AT ALL (not
  // even the vertical-only anchorless fallback).
  const trimOk = trimResolution.status === 'resolved';
  const bleedNotUnavailable =
    intent.bleed === false || bleedResolution.status === 'resolved' || bleedResolution.status === 'partial';
  const bleedFullyResolved = intent.bleed === false || bleedResolution.status === 'resolved';

  let geometryStatus;
  if (!trimOk || !bleedNotUnavailable) {
    geometryStatus = 'unavailable';
  } else if (trimOk && bleedFullyResolved && sz.horizontalResolution === 'exact') {
    geometryStatus = 'complete';
  } else {
    geometryStatus = 'partial';
  }

  // --- complianceConfidence rollup ---
  const hasConflict = trimResolution.conflict || bleedResolution.conflict;
  let complianceConfidence;
  if (hasConflict) {
    complianceConfidence = 'conflict';
  } else if (!trimOk || !bleedNotUnavailable) {
    complianceConfidence = 'insufficient';
  } else {
    complianceConfidence = 'high';
  }

  let anchorSource = 'none';
  if (trimOk && bleedNotUnavailable && intent.bleed) anchorSource = 'trimBox+bleedBox';
  else if (trimOk) anchorSource = 'trimBox';

  // CHECKPOINT 5D audit fix (finding #2): sz.horizontalResolution is
  // lib/zones.js's SEMANTIC-level claim ('exact'/'conservative') and says
  // nothing about whether THIS module actually managed to anchor a real
  // trimBoxPt and build a real safeZoneBBoxPt from it -- e.g. when there's
  // no explicit /TrimBox in the file, trimBoxPt stays null, the whole
  // safe-zone block above is skipped, and safeZoneBBoxPt stays null too.
  // Reporting 'exact'/'conservative' in that case would claim a resolution
  // the geometric layer never actually produced. The invariant this
  // module must uphold: horizontalResolution can only be 'exact' or
  // 'conservative' when safeZoneBBoxPt genuinely exists.
  const horizontalResolution = safeZoneBBoxPt ? sz.horizontalResolution || 'unresolved' : 'unresolved';

  return {
    trimBoxPt,
    bleedBoxPt,
    safeZoneBBoxPt,
    horizontalResolution,
    orientationHypotheses,
    coordinateSystem: { anchorSource, rotationDeg },
    geometryStatus,
    complianceConfidence,
    source: {
      trim: trimOk ? 'trimBox-anchored' : 'none',
      bleed: intent.bleed === false ? 'none' : bleedNotUnavailable ? bleedResolution.status : 'none',
      margins: sz.sources ? sz.sources.margins : 'kdp',
    },
    diagnostics,
  };
}

module.exports = {
  buildZoneGeometry,
};
