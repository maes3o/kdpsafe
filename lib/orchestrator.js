'use strict';

/**
 * CHECKPOINT 3 (2026-10-05) -- KDPSafe's first end-to-end orchestrator.
 *
 * PDF -> inspectManuscript -> buildZones -> buildZoneGeometry -> SAFETY GATE
 *     -> analyzePageObjects -> classifyViolations -> aggregate -> InspectionResult
 *
 * This module does NOT invent any new KDP policy, does NOT guess page
 * parity / inside-outside placement, and does NOT change any existing
 * module's behavior for callers that don't opt into the new optional
 * `allowedSides` parameter added to lib/margin.js's classifyViolations()
 * alongside this file (see that function's own header for the exact,
 * additive, backward-compatible change).
 *
 * CENTRAL SAFETY RULE (the reason this file exists, per the CHECKPOINT 2
 * audit that found a real, reproduced bug): a geometric boundary that is
 * `null`/`undefined`/`NaN` means UNKNOWN, never zero. A side of an object
 * (`top`/`bottom`/`left`/`right`) is only ever handed to classifyViolations()
 * for evaluation when EVERY geometry boundary that side's comparison
 * depends on (trimBoxPt[edge], safeZoneBBoxPt[edge], and bleedBoxPt[edge]
 * when a bleedBoxPt is present at all) is a resolved finite number. A side
 * that fails this check is never analyzed, never silently treated as
 * "safe", and never lets its page/category declare READY on the strength
 * of a guess.
 *
 * This module is intentionally scoped to the MARGINS/LEM category only
 * (Phase 1 of the project). Phase 2 (color/transparency/fonts) categories
 * are deliberately absent from the result, not faked as a passing check --
 * see the "G decision" from the UI/UX checkpoint this session already
 * agreed on ("не показувати FONTS/COLOR/TRANSPARENCY як ✓, якщо вони ще
 * не перевіряються").
 */

const { PDFDocument } = require('pdf-lib');
const { inspectManuscript } = require('./manuscript');
const { buildZones } = require('./zones');
const { buildZoneGeometry } = require('./zoneGeometry');
const { analyzePageObjects, classifyViolations } = require('./margin');
const { aggregateViolationsForAutofix } = require('./marginPolicy');

const SIDES = ['top', 'bottom', 'left', 'right'];
const EDGE_BY_SIDE = { top: 'maxY', bottom: 'minY', left: 'minX', right: 'maxX' };

/**
 * `null`, `undefined`, and `NaN` are all UNKNOWN -- never coerced to 0,
 * never treated as "resolved". Only a genuine finite number counts.
 */
function isResolvedNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * SAFETY GATE.
 *
 * For every side, independently: that side may be analyzed ONLY IF every
 * geometry boundary classifyViolations() would need to evaluate it is
 * itself a resolved finite number. This function makes NO assumption that
 * top/bottom are "usually known" -- each of the four sides is checked on
 * its own evidence, every time.
 *
 * - trimBoxPt[edge] must be resolved for every side (classifyViolations()
 *   always compares against it first, regardless of side).
 * - safeZoneBBoxPt[edge] must be resolved for every side (the LEM check).
 * - bleedBoxPt[edge] must be resolved for a side ONLY WHEN bleedBoxPt
 *   itself is present (non-null). A `null` bleedBoxPt (e.g. the user
 *   confirmed no bleed) is NOT a failure -- classifyViolations() already
 *   has a safe, explicit `if (!bleedBoxPt) continue` branch for that case,
 *   so a missing bleedBoxPt object never blocks a side on its own. A
 *   *present* bleedBoxPt whose relevant edge is still `null` (e.g. the
 *   horizontal axis of a resolved-vertical-only bleed box) DOES block
 *   that side, for the same reason trim/safe-zone do.
 *
 * @param {{trimBoxPt: object|null, safeZoneBBoxPt: object|null, bleedBoxPt: object|null}} geometry
 * @returns {{top: boolean, bottom: boolean, left: boolean, right: boolean}}
 */
function resolveAllowedSides(geometry) {
  const trimBoxPt = geometry ? geometry.trimBoxPt : null;
  const safeZoneBBoxPt = geometry ? geometry.safeZoneBBoxPt : null;
  const bleedBoxPt = geometry ? geometry.bleedBoxPt : null;

  const allowed = {};
  for (const side of SIDES) {
    const edge = EDGE_BY_SIDE[side];
    const trimResolved = isResolvedNumber(trimBoxPt ? trimBoxPt[edge] : undefined);
    const safeZoneResolved = isResolvedNumber(safeZoneBBoxPt ? safeZoneBBoxPt[edge] : undefined);
    const bleedResolved = bleedBoxPt == null ? true : isResolvedNumber(bleedBoxPt[edge]);
    allowed[side] = trimResolved && safeZoneResolved && bleedResolved;
  }
  return allowed;
}

function anySideBlocked(allowedSides) {
  return SIDES.some((side) => allowedSides[side] !== true);
}

/**
 * Converts a pdf-lib PDFPage into the `pdfBoxes` shape lib/zones.js and
 * lib/zoneGeometry.js expect -- CRITICALLY, using the page's raw
 * dictionary lookup (`page.node.TrimBox()`/`BleedBox()`) rather than
 * pdf-lib's own `getTrimBox()`/`getBleedBox()` for trim/bleed, because
 * those inherit/default to MediaBox per the PDF spec when the key is
 * absent -- which would make every page look like it has an explicit
 * TrimBox/BleedBox even when it genuinely doesn't. "Absent" must stay
 * absent; it must never be silently defaulted to MediaBox.
 */
function extractPdfBoxes(page) {
  const hasExplicitTrimBox = page.node.TrimBox() !== undefined;
  const hasExplicitBleedBox = page.node.BleedBox() !== undefined;
  const rotation = page.getRotation();

  return {
    mediaBox: page.getMediaBox(),
    cropBox: page.getCropBox(),
    trimBox: hasExplicitTrimBox ? page.getTrimBox() : undefined,
    bleedBox: hasExplicitBleedBox ? page.getBleedBox() : undefined,
    rotationDeg: rotation ? rotation.angle : 0,
  };
}

/** Worst-of rollup for geometryStatus across pages. */
const GEOMETRY_STATUS_RANK = { unavailable: 2, partial: 1, complete: 0 };
/** Worst-of rollup for complianceConfidence across pages. */
const CONFIDENCE_RANK = { conflict: 2, insufficient: 1, high: 0 };

function worstOf(rankTable, values) {
  let worst = null;
  let worstRank = -1;
  for (const v of values) {
    const rank = rankTable[v] ?? -1;
    if (rank > worstRank) {
      worstRank = rank;
      worst = v;
    }
  }
  return worst;
}

/**
 * Per-page: build semantic + geometric zones, run the safety gate, analyze
 * objects, and classify violations only on the sides the gate allows.
 */
async function processPage(pdfBytes, pageIndex, pdfBoxes, userIntent, pageCount) {
  const semanticZones = buildZones(
    { pageCount, pageNumber: pageIndex + 1, pdfBoxes, rotationDeg: pdfBoxes.rotationDeg },
    userIntent
  );
  const geometry = buildZoneGeometry(semanticZones, pdfBoxes);
  const allowedSides = resolveAllowedSides(geometry);

  const objects = await analyzePageObjects(pdfBytes, pageIndex);

  const violations = [];
  const manualReviewEntries = [];

  if (geometry.trimBoxPt) {
    const zones = {
      trimBoxPt: geometry.trimBoxPt,
      safeZoneBBoxPt: geometry.safeZoneBBoxPt,
      bleedBoxPt: geometry.bleedBoxPt,
    };
    for (const obj of objects) {
      const objViolations = classifyViolations(obj, zones, allowedSides);
      for (const v of objViolations) {
        violations.push({ ...v, pageIndex });
      }
      const aggregate = aggregateViolationsForAutofix(objViolations);
      if (aggregate.recommendedAction === 'manual_review') {
        manualReviewEntries.push({
          pageIndex,
          reason: aggregate.hasBleed ? 'BLEED_VIOLATION' : aggregate.hasText ? 'TEXT_LEM_VIOLATION' : 'LEM_VIOLATION_OVER_AUTOFIX_THRESHOLD',
          sides: aggregate.sides,
          maxAmountPt: aggregate.maxAmountPt,
        });
      }
    }
  }

  if (anySideBlocked(allowedSides)) {
    manualReviewEntries.push({
      pageIndex,
      reason: 'HORIZONTAL_GEOMETRY_UNRESOLVED',
      sides: SIDES.filter((s) => !allowedSides[s]),
      maxAmountPt: null,
    });
  }

  return {
    pageIndex,
    geometry,
    allowedSides,
    violations,
    manualReviewEntries,
    objectCount: objects.length,
  };
}

/**
 * Rolls up all per-object aggregate outcomes + the safety-gate's own
 * manual-review entries into one category-level status. A blocked side
 * ALWAYS forces at least 'manual_review' for this category, independent
 * of whether any concrete violation was found on the sides that COULD be
 * checked -- an empty violations list is not the same thing as "known
 * safe" when part of the geometry is unknown.
 */
function rollUpMarginsCategory(pageResults) {
  const violations = [];
  const manualReview = [];
  const diagnostics = [];
  let hasManualReview = false;
  let hasCandidate = false;

  for (const page of pageResults) {
    violations.push(...page.violations);
    manualReview.push(...page.manualReviewEntries);
    diagnostics.push(...page.geometry.diagnostics.map((d) => ({ ...d, pageIndex: page.pageIndex })));

    // Per-object aggregates were already folded into manualReviewEntries
    // (one entry per object whose aggregate was 'manual_review', plus one
    // page-level entry when the safety gate blocked a side). Any violation
    // that didn't come from a 'manual_review' object is, by construction of
    // aggregateViolationsForAutofix(), from a 'candidate' (autofix-eligible)
    // object -- used here only to distinguish 'needs_attention' from
    // 'ready' once we know nothing forced manual review.
    if (page.manualReviewEntries.length > 0) {
      hasManualReview = true;
    } else if (page.violations.length > 0) {
      hasCandidate = true;
    }
  }

  let status;
  if (hasManualReview) status = 'manual_review';
  else if (hasCandidate) status = 'needs_attention';
  else status = 'ready';

  return { status, violations, manualReview, diagnostics };
}

const VERDICT_RANK = { manual_review: 2, needs_attention: 1, ready: 0 };
const VERDICT_LABEL = {
  manual_review: 'MANUAL_REVIEW_REQUIRED',
  needs_attention: 'NEEDS_ATTENTION',
  ready: 'READY',
};

function computeVerdict(categories) {
  let worstRank = -1;
  let worstStatus = 'ready';
  for (const key of Object.keys(categories)) {
    const rank = VERDICT_RANK[categories[key].status] ?? 0;
    if (rank > worstRank) {
      worstRank = rank;
      worstStatus = categories[key].status;
    }
  }
  return VERDICT_LABEL[worstStatus];
}

/**
 * runPreflight(pdfBytes, { userIntent, pageContext }) -> InspectionResult
 *
 * userIntent: { trimSize: { widthIn, heightIn }, bleed: boolean } --
 *   required, user-confirmed product intent (see lib/zones.js's header for
 *   why this is never derived from PDF geometry).
 * pageContext: { pageCount? } -- optional override; defaults to the
 *   manuscript's own detected page count (inspectManuscript()'s result),
 *   which is what the KDP gutter-margin table is keyed on.
 *
 * Structured so a future `applyAutofix(pdfBytes, inspectionResult)` +
 * second `runPreflight(fixedPdfBytes, opts)` call (CHECKPOINT 4+) slots in
 * without restructuring this function: this is already just "build an
 * InspectionResult from a PDF's current bytes", callable twice.
 */
async function runPreflight(pdfBytes, opts = {}) {
  const userIntent = opts.userIntent || {};
  const manuscript = await inspectManuscript(pdfBytes);
  const pageCount = (opts.pageContext && opts.pageContext.pageCount) ?? manuscript.pageCount;

  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();

  const pageResults = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const pdfBoxes = extractPdfBoxes(pages[pageIndex]);
    const pageResult = await processPage(pdfBytes, pageIndex, pdfBoxes, userIntent, pageCount);
    pageResults.push(pageResult);
  }

  const geometryStatuses = pageResults.map((p) => p.geometry.geometryStatus);
  const geometryConfidences = pageResults.map((p) => p.geometry.complianceConfidence);

  const margins = rollUpMarginsCategory(pageResults);
  const categories = { margins };

  const result = {
    document: {
      pageCount: manuscript.pageCount,
      trimWidthIn: manuscript.trimWidthIn,
      trimHeightIn: manuscript.trimHeightIn,
      pageSizeConsistent: manuscript.pageSizeConsistent,
    },
    geometry: {
      status: worstOf(GEOMETRY_STATUS_RANK, geometryStatuses),
      confidence: worstOf(CONFIDENCE_RANK, geometryConfidences),
      pages: pageResults.map((p) => ({
        pageIndex: p.pageIndex,
        status: p.geometry.geometryStatus,
        confidence: p.geometry.complianceConfidence,
        trimBox: p.geometry.trimBoxPt,
        bleedBox: p.geometry.bleedBoxPt,
        safeZone: p.geometry.safeZoneBBoxPt,
        allowedSides: p.allowedSides,
        diagnostics: p.geometry.diagnostics,
      })),
    },
    categories,
    violations: margins.violations,
    verdict: computeVerdict(categories),
  };

  return result;
}

module.exports = {
  runPreflight,
  resolveAllowedSides,
  isResolvedNumber,
};
