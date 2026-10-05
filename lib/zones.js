'use strict';

/**
 * KDPSafe policy -> geometry layer ("zones-builder"), isolated module
 * (2026-10-05 implementation checkpoint, built on the frozen "KDPSafe
 * Zones Policy v1" spec from this session's preceding policy checkpoints).
 *
 * This module is DELIBERATELY NOT wired into any production path yet:
 * analyzePageObjects(), classifyViolations(), planAutofix() and
 * planAutofixForPage() are untouched and unaware this file exists. It
 * exists to let the policy->geometry mapping be designed and unit-tested
 * on its own, before any integration decision is made.
 *
 * ---------------------------------------------------------------------
 * CENTRAL POLICY PRINCIPLE (bleed/trim intent, per the frozen policy doc):
 *
 *   User-confirmed trim size and bleed choice are the AUTHORITATIVE
 *   product intent. PDF page geometry (MediaBox/CropBox/TrimBox/BleedBox)
 *   is EVIDENCE for consistency diagnostics only -- it never overrides,
 *   derives, or silently corrects the user's stated intent. MediaBox in
 *   particular is informational-only and never gates autofix.
 *
 * ---------------------------------------------------------------------
 * KNOWN, PERMANENT ARCHITECTURAL LIMITATION (not a per-call confidence
 * signal -- see the final report delivered alongside this module):
 *
 *   KDP's inside/outside (gutter vs. outer-edge) margin and bleed rules
 *   are asymmetric left<->right, but nothing anywhere in this repository
 *   (pageContext, userIntent, or any existing production code) carries
 *   page parity / page-side (left-hand vs. right-hand page of a spread)
 *   information. Per the explicit instruction for this checkpoint, this
 *   module does NOT invent a left/right assignment. It builds every axis
 *   it CAN determine deterministically (trim entirely; the vertical
 *   extent of bleed/safe-zone, since top/bottom are never gutter-side-
 *   dependent) and leaves the horizontal (inside/outside) extent of
 *   bleedBoxPt/safeZoneBBoxPt explicitly unresolved (`minX`/`maxX: null`),
 *   flagged with a dedicated diagnostic, rather than guessing which
 *   physical side is the gutter.
 */

const { TOLERANCE_PT } = require('./margin');

const IN_TO_PT = 72;
function inToPt(valueIn) {
  return valueIn * IN_TO_PT;
}

// --- KDP minimum margin requirements / KDP compliance thresholds -------
// (Source: KDP Help, "Trim size" topic, https://kdp.amazon.com/help/topic/G201857950.
// Per the frozen policy doc: KDPSafe recommended safe margin = KDP minimum
// margin for this v1 -- no additional arbitrary safety buffer is added.)

const TOP_BOTTOM_OUTSIDE_WITH_BLEED_IN = 0.375;
const TOP_BOTTOM_OUTSIDE_WITHOUT_BLEED_IN = 0.25;

// Inside/gutter margin by page count. Ranges are the exact KDP table;
// deliberately contiguous and exhaustive over [24, 828] so no gap inside
// that range can fall through silently.
const GUTTER_TABLE_IN = [
  { min: 24, max: 150, insideIn: 0.375 },
  { min: 151, max: 300, insideIn: 0.5 },
  { min: 301, max: 500, insideIn: 0.625 },
  { min: 501, max: 700, insideIn: 0.75 },
  { min: 701, max: 828, insideIn: 0.875 },
];

// Interior bleed amounts (KDP: "extend 0.125in beyond trim from top,
// bottom, and outer edge" -- NOT the gutter/inside edge). Kept as three
// separate named constants (rather than one BLEED_IN reused on every
// side) specifically so the asymmetry can never be collapsed back into a
// symmetric expansion by accident.
const BLEED_OUTER_IN = 0.125;
const BLEED_TOP_IN = 0.125;
const BLEED_BOTTOM_IN = 0.125;
const BLEED_INSIDE_IN = 0; // bleed never applies to the gutter/inside edge

/**
 * Looks up the KDP inside/gutter margin for a given page count.
 * Returns { insideIn, diagnostic } -- insideIn is null (never guessed)
 * when pageCount is missing or outside the KDP-documented [24, 828]
 * range; diagnostic names exactly why.
 */
function lookupGutterMarginIn(pageCount) {
  if (pageCount === null || pageCount === undefined) {
    return { insideIn: null, diagnostic: 'PAGE_COUNT_MISSING' };
  }
  if (typeof pageCount !== 'number' || !Number.isFinite(pageCount)) {
    return { insideIn: null, diagnostic: 'PAGE_COUNT_MISSING' };
  }
  if (pageCount < 24 || pageCount > 828) {
    return { insideIn: null, diagnostic: 'PAGE_COUNT_OUT_OF_SUPPORTED_RANGE' };
  }
  const row = GUTTER_TABLE_IN.find((r) => pageCount >= r.min && pageCount <= r.max);
  // Unreachable given the table above is contiguous over [24,828], but
  // fails safe (no guessed value) rather than throwing if it ever isn't.
  if (!row) {
    return { insideIn: null, diagnostic: 'PAGE_COUNT_OUT_OF_SUPPORTED_RANGE' };
  }
  return { insideIn: row.insideIn, diagnostic: null };
}

/**
 * Computes the semantic (non-geometric) margin policy -- the
 * {topPt,bottomPt,insidePt,outsidePt} structure the frozen policy doc
 * calls for, BEFORE any attempt to place it into a {minX,minY,maxX,maxY}
 * bbox. top/bottom/outside depend only on the bleed choice (never on
 * page count or page side); inside depends only on page count (never on
 * bleed or page side).
 */
function computeMarginsPt(bleed, pageCount) {
  const topBottomOutsideIn = bleed ? TOP_BOTTOM_OUTSIDE_WITH_BLEED_IN : TOP_BOTTOM_OUTSIDE_WITHOUT_BLEED_IN;
  const { insideIn, diagnostic: gutterDiagnostic } = lookupGutterMarginIn(pageCount);

  const marginsPt = {
    topPt: inToPt(topBottomOutsideIn),
    bottomPt: inToPt(topBottomOutsideIn),
    outsidePt: inToPt(topBottomOutsideIn),
    insidePt: insideIn === null ? null : inToPt(insideIn),
  };

  return { marginsPt, gutterDiagnostic };
}

/**
 * Converts a pdf-lib-shaped box ({x,y,width,height}, as confirmed by the
 * 2026-10-05 page-geometry-contract validation checkpoint to be exactly
 * what PDFPage.getMediaBox()/getTrimBox()/getBleedBox() return) into the
 * {minX,minY,maxX,maxY} shape the rest of this module and
 * lib/margin.js's `zones` use. Returns null for an absent box.
 */
function toMinMaxBox(box) {
  if (!box) return null;
  return { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height };
}

/**
 * Width/height of a {minX,minY,maxX,maxY} box, in points.
 */
function dimsOf(box) {
  return { widthPt: box.maxX - box.minX, heightPt: box.maxY - box.minY };
}

function approxEqual(a, b, epsilon) {
  return Math.abs(a - b) <= epsilon;
}

/**
 * Checks a real PDF TrimBox's DIMENSIONS (never its absolute position --
 * this module's own trimBoxPt is built in an abstract, origin-anchored
 * frame, since nothing here is tied to a specific page's real
 * coordinate placement; see the module header) against the expected
 * trim dimensions from user intent. Position is deliberately not
 * compared -- see "PDF BOX CONSISTENCY" in the final report for why.
 */
function checkTrimBoxConsistency(pdfTrimBoxMinMax, expectedTrimDimsPt) {
  if (!pdfTrimBoxMinMax) return { status: 'absent', diagnostic: null };
  const actual = dimsOf(pdfTrimBoxMinMax);
  const widthOk = approxEqual(actual.widthPt, expectedTrimDimsPt.widthPt, TOLERANCE_PT);
  const heightOk = approxEqual(actual.heightPt, expectedTrimDimsPt.heightPt, TOLERANCE_PT);
  if (widthOk && heightOk) return { status: 'consistent', diagnostic: null };
  return { status: 'conflict', diagnostic: 'TRIM_BOX_CONFLICTS_WITH_USER_INTENT' };
}

/**
 * Same idea for BleedBox, against the expected bleed dimensions implied
 * by the user's bleed choice (trim + the asymmetric KDP bleed formula).
 * When userIntent.bleed === false, a BleedBox whose dimensions match the
 * "with bleed" formula is itself the inconsistency being checked for
 * (PDF geometry silently implying bleed the user said isn't there).
 */
function checkBleedBoxConsistency(pdfBleedBoxMinMax, bleed, expectedTrimDimsPt) {
  if (!pdfBleedBoxMinMax) return { status: 'absent', diagnostic: null };
  const actual = dimsOf(pdfBleedBoxMinMax);
  const expectedWithBleedPt = {
    widthPt: expectedTrimDimsPt.widthPt + inToPt(BLEED_OUTER_IN),
    heightPt: expectedTrimDimsPt.heightPt + inToPt(BLEED_TOP_IN) + inToPt(BLEED_BOTTOM_IN),
  };
  const matchesTrim = approxEqual(actual.widthPt, expectedTrimDimsPt.widthPt, TOLERANCE_PT) && approxEqual(actual.heightPt, expectedTrimDimsPt.heightPt, TOLERANCE_PT);
  const matchesWithBleed = approxEqual(actual.widthPt, expectedWithBleedPt.widthPt, TOLERANCE_PT) && approxEqual(actual.heightPt, expectedWithBleedPt.heightPt, TOLERANCE_PT);

  if (bleed) {
    if (matchesWithBleed) return { status: 'consistent', diagnostic: null };
    return { status: 'conflict', diagnostic: 'BLEED_BOX_CONFLICTS_WITH_USER_INTENT' };
  }
  // bleed === false: a BleedBox that looks like "trim" is unremarkable
  // (some tools write a BleedBox equal to TrimBox when there is no
  // bleed); a BleedBox that looks like "trim + KDP bleed" contradicts
  // the user's stated no-bleed intent and must not be silently accepted.
  if (matchesWithBleed && !matchesTrim) {
    return { status: 'conflict', diagnostic: 'BLEED_BOX_GEOMETRY_IMPLIES_BLEED_BUT_USER_SAID_NO_BLEED' };
  }
  return { status: 'consistent', diagnostic: null };
}

/**
 * MediaBox is informational-only, per policy: it may produce a hint
 * about what the page "looks like" (trim-sized vs. trim+bleed-sized vs.
 * neither), but this NEVER becomes a diagnostic of type 'conflict' and
 * NEVER feeds into confidence -- only an advisory string.
 */
function describeMediaBoxHint(pdfMediaBoxMinMax, expectedTrimDimsPt) {
  if (!pdfMediaBoxMinMax) return null;
  const actual = dimsOf(pdfMediaBoxMinMax);
  const expectedWithBleedPt = {
    widthPt: expectedTrimDimsPt.widthPt + inToPt(BLEED_OUTER_IN),
    heightPt: expectedTrimDimsPt.heightPt + inToPt(BLEED_TOP_IN) + inToPt(BLEED_BOTTOM_IN),
  };
  const looksLikeTrim = approxEqual(actual.widthPt, expectedTrimDimsPt.widthPt, TOLERANCE_PT) && approxEqual(actual.heightPt, expectedTrimDimsPt.heightPt, TOLERANCE_PT);
  const looksLikeTrimPlusBleed = approxEqual(actual.widthPt, expectedWithBleedPt.widthPt, TOLERANCE_PT) && approxEqual(actual.heightPt, expectedWithBleedPt.heightPt, TOLERANCE_PT);

  if (looksLikeTrim) return 'MEDIA_BOX_LOOKS_LIKE_TRIM';
  if (looksLikeTrimPlusBleed) return 'MEDIA_BOX_LOOKS_LIKE_TRIM_PLUS_BLEED';
  return 'MEDIA_BOX_AMBIGUOUS';
}

/**
 * buildZones(pageContext, userIntent) -> result contract (see module
 * header / final report for the full rationale).
 *
 * userIntent: { trimSize: { widthIn, heightIn }, bleed: boolean }
 * pageContext: { pageCount?, pageNumber?, pdfBoxes?: { mediaBox?, cropBox?, trimBox?, bleedBox? } }
 *   -- each box in pdfBoxes, if present, is the pdf-lib-shaped
 *   {x,y,width,height} object (as returned by PDFPage.get*Box()).
 *
 * Returns a plain object (see README-style comment above each field
 * below); never throws for missing/ambiguous input -- degrades to
 * diagnostics + null geometry fields instead.
 */
function buildZones(pageContext, userIntent) {
  const diagnostics = [];
  const ctx = pageContext || {};
  const intent = userIntent || {};
  const pdfBoxes = ctx.pdfBoxes || {};

  // --- 1. Trim: authoritative from user intent, deterministic, never
  // derived from any PDF box. ---
  const trimSize = intent.trimSize;
  if (!trimSize || typeof trimSize.widthIn !== 'number' || typeof trimSize.heightIn !== 'number') {
    diagnostics.push({ code: 'TRIM_SIZE_MISSING', message: "userIntent.trimSize відсутній або некоректний -- trim-геометрію побудувати неможливо." });
    return {
      trimBoxPt: null,
      bleedBoxPt: null,
      marginsPt: null,
      safeZoneBBoxPt: null,
      horizontalResolution: 'unresolved',
      insideIsLeft: null,
      orientationHypotheses: null,
      bleedHorizontalResolution: 'unresolved',
      intent: { trimSize: trimSize || null, bleed: typeof intent.bleed === 'boolean' ? intent.bleed : null },
      sources: { trim: 'user', bleed: 'user', margins: 'kdp' },
      confidence: 'insufficient',
      diagnostics,
    };
  }

  const expectedTrimDimsPt = { widthPt: inToPt(trimSize.widthIn), heightPt: inToPt(trimSize.heightIn) };
  // Abstract, origin-anchored reference frame -- see module header for
  // why this is deliberately NOT tied to any real page's coordinate
  // placement (that would make MediaBox/TrimBox placement authoritative,
  // which the frozen policy explicitly forbids).
  const trimBoxPt = { minX: 0, minY: 0, maxX: expectedTrimDimsPt.widthPt, maxY: expectedTrimDimsPt.heightPt };

  if (typeof intent.bleed !== 'boolean') {
    diagnostics.push({ code: 'BLEED_INTENT_MISSING', message: "userIntent.bleed відсутній -- bleed-геометрію та LEM-поля, залежні від bleed, побудувати неможливо." });
    return {
      trimBoxPt,
      bleedBoxPt: null,
      marginsPt: null,
      safeZoneBBoxPt: null,
      horizontalResolution: 'unresolved',
      insideIsLeft: null,
      orientationHypotheses: null,
      bleedHorizontalResolution: 'unresolved',
      intent: { trimSize, bleed: null },
      sources: { trim: 'user', bleed: 'user', margins: 'kdp' },
      confidence: 'insufficient',
      diagnostics,
    };
  }
  const bleed = intent.bleed;

  // --- 2. Margins (semantic policy level, not yet geometric). Moved
  // ahead of bleed/safe-zone geometry construction (CHECKPOINT 5C,
  // 2026-10-05) because BOTH boxes' horizontal resolution now depends on
  // insidePt/outsidePt being known. ---
  const { marginsPt, gutterDiagnostic } = computeMarginsPt(bleed, ctx.pageCount);
  if (gutterDiagnostic) {
    diagnostics.push({
      code: gutterDiagnostic,
      message:
        gutterDiagnostic === 'PAGE_COUNT_MISSING'
          ? 'pageContext.pageCount відсутній -- inside/gutter margin (залежний від кількості сторінок за таблицею KDP) не може бути визначений; значення не вгадується.'
          : `pageContext.pageCount (${ctx.pageCount}) виходить за межі діапазону, визначеного поточною KDP-таблицею (24-828 сторінок) -- inside/gutter margin для цього діапазону цією policy не визначений.`,
    });
  }

  // --- 3. HORIZONTAL ORIENTATION RESOLUTION (CHECKPOINT 5C, Option D) ---
  //
  // Three possible outcomes, in `horizontalResolution`:
  //   'exact'        -- userIntent.readingDirection ('ltr'|'rtl') AND a
  //                      valid pageContext.pageNumber (>=1 integer) were
  //                      both given, AND insidePt/outsidePt are both
  //                      known. Which physical edge is "inside" is then
  //                      fully determined (`insideIsLeft`), and BOTH
  //                      safeZoneBBoxPt and (when bleed=true) bleedBoxPt
  //                      resolve their horizontal axis exactly -- no
  //                      conservative/ambiguous object can exist on a
  //                      page resolved this way.
  //   'conservative' -- readingDirection/pageNumber not (both) given, but
  //                      insidePt/outsidePt ARE both known. Per the
  //                      CHECKPOINT 5A proof (intersection(LTR,RTL) is
  //                      geometrically the exact set of x-coordinates safe
  //                      under BOTH possible orientations), safeZoneBBoxPt
  //                      resolves to that conservative, orientation-
  //                      independent zone: minX = trim.minX +
  //                      max(insidePt, outsidePt), maxX = trim.maxX -
  //                      max(insidePt, outsidePt). `inside >= outside` is
  //                      NEVER assumed -- max() is computed generically.
  //                      bleedBoxPt's horizontal axis is explicitly NOT
  //                      given this treatment (CHECKPOINT 5A proved the
  //                      conservative bleed intersection degenerates to
  //                      the bare trim box -- BLEED_INSIDE_IN is 0 -- zero
  //                      additional tolerance on either side, so there is
  //                      nothing to gain and it stays unresolved).
  //   'unresolved'   -- insidePt and/or outsidePt themselves are not known
  //                      (pageCount problem) -- not even the conservative
  //                      zone can be built. Same as this module's
  //                      pre-5C behavior.
  //
  // `orientationHypotheses` (populated ONLY in 'conservative' mode) carries
  // the two named hypothesis boxes an object outside the conservative zone
  // must be re-checked against (lib/orchestrator.js does this, not this
  // module) to distinguish a genuinely AMBIGUOUS object (safe under
  // exactly one hypothesis) from a DEFINITE violation (safe under
  // neither) -- see CHECKPOINT 5A §6 / 5B's object-level contract. This
  // module itself makes NO safe/ambiguous/violation decision for any
  // object -- it only ever describes GEOMETRY.
  const haveBothMargins = marginsPt.insidePt !== null && marginsPt.outsidePt !== null;
  const readingDirection =
    intent.readingDirection === 'ltr' || intent.readingDirection === 'rtl' ? intent.readingDirection : null;
  const pageNumberValid = Number.isInteger(ctx.pageNumber) && ctx.pageNumber >= 1;

  let horizontalResolution = 'unresolved';
  let insideIsLeft = null; // true|false only in 'exact' mode
  let orientationHypotheses = null;

  if (haveBothMargins && readingDirection && pageNumberValid) {
    const isOddPage = ctx.pageNumber % 2 === 1;
    // LTR convention: odd (recto/right-hand) page -> gutter/inside on the
    // LEFT; even (verso/left-hand) page -> gutter/inside on the RIGHT.
    // RTL: the same rule, inverted (per explicit instruction).
    const oddPageInsideIsLeft = readingDirection === 'ltr';
    insideIsLeft = isOddPage ? oddPageInsideIsLeft : !oddPageInsideIsLeft;
    horizontalResolution = 'exact';
  } else if (haveBothMargins) {
    horizontalResolution = 'conservative';
    orientationHypotheses = {
      ltr: { minX: trimBoxPt.minX + marginsPt.insidePt, maxX: trimBoxPt.maxX - marginsPt.outsidePt },
      rtl: { minX: trimBoxPt.minX + marginsPt.outsidePt, maxX: trimBoxPt.maxX - marginsPt.insidePt },
    };
  }

  // --- 4. Bleed geometry: top/bottom are never gutter-side-dependent, so
  // they're fully deterministic. The horizontal (outer vs. inside) extent
  // is gutter-side-dependent: resolved exactly when 'exact' orientation is
  // known, otherwise left unresolved -- conservative treatment is
  // DELIBERATELY NOT applied here (see §3 above / CHECKPOINT 5A §5: it
  // would degenerate to the bare trim box, zero benefit). ---
  let bleedBoxPt = null;
  let bleedHorizontalResolution = 'unresolved';
  if (bleed) {
    bleedBoxPt = {
      minX: null,
      minY: trimBoxPt.minY - inToPt(BLEED_BOTTOM_IN),
      maxX: null,
      maxY: trimBoxPt.maxY + inToPt(BLEED_TOP_IN),
    };
    if (horizontalResolution === 'exact') {
      bleedBoxPt.minX = insideIsLeft ? trimBoxPt.minX - inToPt(BLEED_INSIDE_IN) : trimBoxPt.minX - inToPt(BLEED_OUTER_IN);
      bleedBoxPt.maxX = insideIsLeft ? trimBoxPt.maxX + inToPt(BLEED_OUTER_IN) : trimBoxPt.maxX + inToPt(BLEED_INSIDE_IN);
      bleedHorizontalResolution = 'exact';
      diagnostics.push({
        code: 'BLEED_HORIZONTAL_RESOLVED_EXACT_ORIENTATION',
        message: `readingDirection=${readingDirection}, pageNumber=${ctx.pageNumber} -> inside=${insideIsLeft ? 'left' : 'right'}. bleedBoxPt горизонтально повністю й точно визначений (inside=+0in, outside=+${BLEED_OUTER_IN}in).`,
      });
    } else {
      diagnostics.push({
        code: 'BLEED_HORIZONTAL_EDGE_UNRESOLVED_WITHOUT_PAGE_PARITY',
        message:
          "Горизонтальний bleed (outer=+0.125in, inside/gutter=+0in) асиметричний відносно лівого/правого краю. Без userIntent.readingDirection + pageContext.pageNumber ця вісь НЕ резолвиться -- і, на відміну від safe zone, conservative-підхід тут свідомо не застосовується (CHECKPOINT 5A §5 довів, що це вироджується в голий trim box, без жодної користі). minX/maxX bleedBoxPt залишені null.",
      });
    }
  }

  // --- 5. safeZoneBBoxPt: vertical extent is always deterministic;
  // horizontal extent follows `horizontalResolution` from §3 above. ---
  let safeZoneMinX = null;
  let safeZoneMaxX = null;
  if (horizontalResolution === 'exact') {
    safeZoneMinX = insideIsLeft ? trimBoxPt.minX + marginsPt.insidePt : trimBoxPt.minX + marginsPt.outsidePt;
    safeZoneMaxX = insideIsLeft ? trimBoxPt.maxX - marginsPt.outsidePt : trimBoxPt.maxX - marginsPt.insidePt;
    diagnostics.push({
      code: 'SAFE_ZONE_HORIZONTAL_RESOLVED_EXACT_ORIENTATION',
      message: `readingDirection=${readingDirection}, pageNumber=${ctx.pageNumber} -> inside=${insideIsLeft ? 'left' : 'right'}. safeZoneBBoxPt горизонтально повністю й точно визначений -- жодної orientation-ambiguity на цій сторінці немає.`,
    });
  } else if (horizontalResolution === 'conservative') {
    const conservativeMarginPt = Math.max(marginsPt.insidePt, marginsPt.outsidePt); // never assumes inside>=outside
    safeZoneMinX = trimBoxPt.minX + conservativeMarginPt;
    safeZoneMaxX = trimBoxPt.maxX - conservativeMarginPt;
    diagnostics.push({
      code: 'SAFE_ZONE_HORIZONTAL_CONSERVATIVE_ORIENTATION_INDEPENDENT',
      message:
        'userIntent.readingDirection не задано -- safeZoneBBoxPt горизонтально побудований як conservative intersection(LTR,RTL) = [trim.minX+max(insidePt,outsidePt), trim.maxX-max(insidePt,outsidePt)]. Математично доведено безпечний відносно READY (CHECKPOINT 5A): об’єкт усередині цієї зони безпечний за ОБОХ можливих orientation. Об’єкт поза нею може виявитись SAFE під лише однією з гіпотез (AMBIGUOUS, не violation) -- див. orientationHypotheses та CHECKPOINT 5B.',
    });
  } else {
    diagnostics.push({
      code: 'SAFE_ZONE_HORIZONTAL_EDGE_UNRESOLVED_WITHOUT_PAGE_PARITY',
      message:
        "insidePt і/або outsidePt не визначені (pageContext.pageCount відсутній або поза підтримуваним діапазоном -- див. окремий діагностик) -- навіть conservative safe zone побудувати неможливо, а page parity й readingDirection для exact-резолюції ніде не передані.",
    });
  }

  const safeZoneBBoxPt = {
    minX: safeZoneMinX,
    minY: trimBoxPt.minY + marginsPt.bottomPt,
    maxX: safeZoneMaxX,
    maxY: trimBoxPt.maxY - marginsPt.topPt,
  };

  // --- 5. PDF box consistency diagnostics (evidence only, never
  // authoritative; MediaBox never affects confidence). ---
  const pdfTrimBoxMinMax = toMinMaxBox(pdfBoxes.trimBox);
  const pdfBleedBoxMinMax = toMinMaxBox(pdfBoxes.bleedBox);
  const pdfMediaBoxMinMax = toMinMaxBox(pdfBoxes.mediaBox);
  // CropBox/ArtBox: diagnostic-only/unused for v1, per explicit
  // instruction not to add speculative behavior for them.

  let hasConflict = false;

  const trimCheck = checkTrimBoxConsistency(pdfTrimBoxMinMax, expectedTrimDimsPt);
  if (trimCheck.status === 'conflict') {
    hasConflict = true;
    diagnostics.push({ code: trimCheck.diagnostic, message: 'Явний /TrimBox PDF-файлу за розмірами не відповідає підтвердженому користувачем trim size.' });
  } else if (trimCheck.status === 'consistent') {
    diagnostics.push({ code: 'TRIM_BOX_CONSISTENT', message: 'Явний /TrimBox PDF-файлу узгоджується з підтвердженим trim size (лише перевірка розмірів, без позиції).' });
  }

  const bleedCheck = checkBleedBoxConsistency(pdfBleedBoxMinMax, bleed, expectedTrimDimsPt);
  if (bleedCheck.status === 'conflict') {
    hasConflict = true;
    diagnostics.push({
      code: bleedCheck.diagnostic,
      message:
        bleedCheck.diagnostic === 'BLEED_BOX_GEOMETRY_IMPLIES_BLEED_BUT_USER_SAID_NO_BLEED'
          ? "Явний /BleedBox за розмірами відповідає формулі 'trim + KDP bleed', але користувач підтвердив відсутність bleed -- це розбіжність, яка не повинна тихо змінювати підтверджений intent."
          : "Явний /BleedBox PDF-файлу за розмірами не відповідає очікуваній bleed-геометрії для підтвердженого bleed-вибору.",
    });
  } else if (bleedCheck.status === 'consistent') {
    diagnostics.push({ code: 'BLEED_BOX_CONSISTENT', message: 'Явний /BleedBox узгоджується з підтвердженим bleed-вибором (лише перевірка розмірів).' });
  }

  const mediaHint = describeMediaBoxHint(pdfMediaBoxMinMax, expectedTrimDimsPt);
  if (mediaHint) {
    diagnostics.push({ code: mediaHint, message: 'MediaBox -- лише інформаційна підказка, ніколи не є авторитетним джерелом і не впливає на confidence.' });
  }

  // --- 6. Rotation: informational only, no transform, no mutation of
  // any geometry above. ---
  if (typeof ctx.rotationDeg === 'number' && ctx.rotationDeg !== 0) {
    diagnostics.push({
      code: 'NON_ZERO_PAGE_ROTATION',
      message: `Сторінка має /Rotate=${ctx.rotationDeg}. Поточна v1 policy залишається у raw/unrotated PDF user-space -- жодна геометрія вище не трансформована.`,
    });
  }

  // --- 7. Confidence: reflects whether the POLICY inputs themselves
  // (trim/bleed intent, page count, PDF-box consistency) are sufficient
  // and non-conflicting. The permanent page-parity geometry gap (points
  // 2/4 above) is NOT folded into this signal -- it is a structural,
  // always-present limitation of this architecture stage, not a
  // per-call confidence degradation. See final report.
  let confidence;
  if (hasConflict) {
    confidence = 'conflict';
  } else if (gutterDiagnostic) {
    confidence = 'insufficient';
  } else {
    confidence = 'high';
  }

  return {
    trimBoxPt,
    bleedBoxPt,
    marginsPt,
    safeZoneBBoxPt,
    horizontalResolution,
    insideIsLeft,
    orientationHypotheses,
    bleedHorizontalResolution,
    intent: { trimSize, bleed },
    sources: { trim: 'user', bleed: 'user', margins: 'kdp' },
    confidence,
    diagnostics,
  };
}

module.exports = {
  buildZones,
  IN_TO_PT,
  inToPt,
  lookupGutterMarginIn,
  GUTTER_TABLE_IN,
  TOP_BOTTOM_OUTSIDE_WITH_BLEED_IN,
  TOP_BOTTOM_OUTSIDE_WITHOUT_BLEED_IN,
  BLEED_OUTER_IN,
  BLEED_TOP_IN,
  BLEED_BOTTOM_IN,
  BLEED_INSIDE_IN,
};
