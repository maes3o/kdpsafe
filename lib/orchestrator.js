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
const { planAutofix } = require('./autofix');

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
 * CHECKPOINT 4 (2026-10-05): true only when EVERY side is gate-allowed, not
 * just the sides a particular object happened to violate.
 *
 * Why this is stricter than it looks: lib/autofix.js's computeShiftToFit()
 * always measures the object's bbox against the FULL safeZoneBBoxPt,
 * including whichever axis the object's own violations never touched. When
 * the horizontal axis is unresolved (today, always), safeZoneBBoxPt.minX/
 * maxX are `null`, and `null - null` arithmetic inside computeShiftToFit()
 * would silently coerce to 0 -- the exact class of bug CHECKPOINT 2/3 found
 * and fixed for classifyViolations(), just one level up the call chain.
 * Rather than teach autofix.js's shift math to reason about partially-
 * resolved zones (a real, separate design task, explicitly not requested
 * this checkpoint), autofix PLANNING is only ever attempted when the whole
 * zone is fully resolved. This is also the honest reading of the user's own
 * instruction: "Зокрема поточний unresolved horizontal geometry залишається
 * MANUAL_REVIEW" was not scoped to "only objects with a left/right
 * violation" -- any object's plan would still risk reading a null-derived
 * safe-zone width.
 */
function allSidesAllowed(allowedSides) {
  return SIDES.every((side) => allowedSides[side] === true);
}

const RECT_MATCH_EPSILON_PT = 0.01;

function bboxesApproxEqual(a, b, epsilon) {
  if (!a || !b) return false;
  return (
    Math.abs(a.minX - b.minX) <= epsilon &&
    Math.abs(a.minY - b.minY) <= epsilon &&
    Math.abs(a.maxX - b.maxX) <= epsilon &&
    Math.abs(a.maxY - b.maxY) <= epsilon
  );
}

/**
 * Can lib/geometryRewriter.js's shiftRectInContentStream() actually locate
 * and patch THIS object's bytes? Narrower than "planAutofix said status:
 * 'autofix'" -- that only judges whether a shift is semantically safe, not
 * whether this repo's v1 byte-level rewriter can physically perform it.
 *
 * Restricted to: a 'path' object (the only type drawn via a plain `re`
 * operator), not stroked (a stroked path's rawBBoxPt already has stroke-
 * width padding baked in, so it would never byte-match the literal `re`
 * operands), and NOT under an active clip (rawBBoxPt === visibleBBoxPt) --
 * geometryRewriter shifts the raw drawn rectangle, and reasoning about a
 * clip that stays in place while the content moves under it is explicitly
 * out of scope for v1.
 */
function isByteApplyable(obj) {
  return (
    obj.type === 'path' &&
    obj.stroked !== true &&
    bboxesApproxEqual(obj.rawBBoxPt, obj.visibleBBoxPt, RECT_MATCH_EPSILON_PT)
  );
}

const AMBIGUITY_RELEVANT_SIDES = new Set(['left', 'right']);

/**
 * CHECKPOINT 5C / 5B object-level contract: a LEM violation on left/right
 * found against the CONSERVATIVE safe zone (geometry.safeZoneBBoxPt, in
 * 'conservative' horizontalResolution mode) is not yet final -- per the
 * CHECKPOINT 5A proof, `object outside conservative` does NOT automatically
 * mean violation; it must be re-checked against the two named orientation
 * hypotheses (geometry.orientationHypotheses) to distinguish:
 *
 *   - DEFINITE violation (unsafe under BOTH ltr and rtl) -- the original
 *     conservative violations[] entry is correct and kept UNCHANGED.
 *   - AMBIGUOUS (safe under exactly one hypothesis) -- NOT a violation.
 *     Removed from violations[] and instead reported as a manualReview[]
 *     entry with reason 'LEM_ORIENTATION_AMBIGUOUS' (never 'LEM_VIOLATION'),
 *     carrying which hypothesis passes/fails so the exact-orientation
 *     resolution flow (userIntent.readingDirection) and any future UI can
 *     use it without recomputation.
 *
 * This reuses classifyViolations() completely unmodified (called with the
 * two hypothesis zones in place of the conservative one) -- no new
 * detection logic. Only ever applies to LEM violations on left/right:
 * BLEED never gets conservative treatment at all (CHECKPOINT 5A §5, zero
 * benefit -- bleedBoxPt's horizontal stays unresolved without
 * readingDirection, so a BLEED-type entry can't even occur here under
 * conservative geometry), and top/bottom are never orientation-dependent.
 * In 'exact' mode geometry.orientationHypotheses is null (zones.js never
 * populates it there -- there is nothing ambiguous left to resolve), so
 * this function is a complete no-op and every violation passes through
 * untouched, exactly as classifyViolations() already decided.
 *
 * @returns {{finalViolations: Array, ambiguousEntries: Array}}
 */
function splitAmbiguousViolations(obj, conservativeViolations, geometry, pageIndex) {
  const hypotheses = geometry.orientationHypotheses;
  if (!hypotheses) return { finalViolations: conservativeViolations, ambiguousEntries: [] };

  const finalViolations = [];
  const ambiguousEntries = [];

  for (const v of conservativeViolations) {
    if (v.violation !== 'LEM' || !AMBIGUITY_RELEVANT_SIDES.has(v.side)) {
      finalViolations.push(v);
      continue;
    }

    // Restrict the re-check to exactly this one side -- top/bottom are
    // unaffected by orientation and must not be re-evaluated here.
    const sideOnly = { top: false, bottom: false, left: v.side === 'left', right: v.side === 'right' };
    const ltrZones = {
      trimBoxPt: geometry.trimBoxPt,
      bleedBoxPt: geometry.bleedBoxPt,
      safeZoneBBoxPt: { ...geometry.safeZoneBBoxPt, minX: hypotheses.ltr.minX, maxX: hypotheses.ltr.maxX },
    };
    const rtlZones = {
      trimBoxPt: geometry.trimBoxPt,
      bleedBoxPt: geometry.bleedBoxPt,
      safeZoneBBoxPt: { ...geometry.safeZoneBBoxPt, minX: hypotheses.rtl.minX, maxX: hypotheses.rtl.maxX },
    };

    const ltrViolates = classifyViolations(obj, ltrZones, sideOnly).some((x) => x.side === v.side);
    const rtlViolates = classifyViolations(obj, rtlZones, sideOnly).some((x) => x.side === v.side);

    if (ltrViolates && rtlViolates) {
      // DEFINITE violation under both orientations -- the conservative
      // entry (already carrying the worst-case amountPt, proven in
      // CHECKPOINT 5A) is correct as-is.
      finalViolations.push(v);
    } else if (ltrViolates || rtlViolates) {
      // AMBIGUOUS: safe under exactly one named hypothesis. Per the
      // CHECKPOINT 5B contract, this is explicitly NEITHER safe NOR a
      // violation -- it is removed from violations[] and reported
      // separately, preserving which hypothesis passes/fails.
      ambiguousEntries.push({
        pageIndex,
        reason: 'LEM_ORIENTATION_AMBIGUOUS',
        sides: [v.side],
        maxAmountPt: v.amountPt,
        type: obj.type,
        rawBBoxPt: obj.rawBBoxPt,
        visibleBBoxPt: obj.visibleBBoxPt,
        orientation: { ltr: ltrViolates ? 'violation' : 'safe', rtl: rtlViolates ? 'violation' : 'safe' },
      });
    } else {
      // Unreachable per the CHECKPOINT 5A proof (conservative failure
      // implies at least one hypothesis also fails -- De Morgan's law on
      // object ⊆ conservative ⟺ object⊆ltr AND object⊆rtl). Fails SAFE
      // rather than silently discarding a flagged violation: keep the
      // original conservative entry instead of ever treating a
      // contradiction as "resolved safe".
      finalViolations.push(v);
    }
  }

  return { finalViolations, ambiguousEntries };
}

/**
 * CHECKPOINT 5D audit fix (finding #1): planAutofix()'s computeShiftToFit()
 * (lib/autofix.js, left completely UNTOUCHED by this fix) always measures
 * the object's bbox against the FULL safeZoneBBoxPt on BOTH axes, from the
 * raw bbox alone -- it has no idea which specific sides are in the
 * violations list passed alongside it. That meant an object carrying an
 * AMBIGUOUS left/right entry (explicitly excluded from objViolations by
 * splitAmbiguousViolations() -- never a confirmed violation, routed to
 * manualReview instead) could still have its horizontal axis silently
 * shifted as a side effect of an autofix plan triggered by a genuinely
 * DEFINITE violation on a DIFFERENT axis (e.g. top) -- contradicting the
 * "ambiguous objects never get an autofix [along the ambiguous axis]"
 * guarantee for exactly the mixed-violation case no pre-5D test exercised.
 *
 * Fix: before calling planAutofix(), "lock" any axis that has an ambiguous
 * entry but NO corresponding DEFINITE violation on that same axis, by
 * expanding safeZoneBBoxPt on that axis so it already contains the
 * object's own bbox on that axis. computeShiftToFit() (unmodified) then
 * measures zero overshoot there BY CONSTRUCTION, so dx (or dy) for the
 * locked axis is guaranteed exactly 0 -- lib/autofix.js itself, every other
 * axis's arithmetic, and the SAFE/AMBIGUOUS/DEFINITE classification itself
 * are all completely unchanged by this fix; it only narrows what geometry
 * the autofix planner is allowed to see for that one object.
 *
 * lockY exists symmetrically (the mirror of lockX) even though no path in
 * this codebase currently produces a top/bottom-ambiguous entry
 * (AMBIGUITY_RELEVANT_SIDES in splitAmbiguousViolations() is {left,right}
 * only) -- written generically so this helper stays correct rather than
 * silently relying on that fact, and so it doesn't need revisiting if
 * vertical ambiguity is ever introduced.
 */
function lockAmbiguousAxes(safeZoneBBoxPt, bbox, ambiguousEntries, objViolations) {
  const ambiguousSides = new Set(ambiguousEntries.flatMap((e) => e.sides));
  const definiteSides = new Set(objViolations.filter((v) => v.violation === 'LEM').map((v) => v.side));

  const lockX =
    (ambiguousSides.has('left') || ambiguousSides.has('right')) &&
    !definiteSides.has('left') &&
    !definiteSides.has('right');
  const lockY =
    (ambiguousSides.has('top') || ambiguousSides.has('bottom')) &&
    !definiteSides.has('top') &&
    !definiteSides.has('bottom');

  if (!lockX && !lockY) return safeZoneBBoxPt;

  return {
    minX: lockX ? Math.min(safeZoneBBoxPt.minX, bbox.minX) : safeZoneBBoxPt.minX,
    maxX: lockX ? Math.max(safeZoneBBoxPt.maxX, bbox.maxX) : safeZoneBBoxPt.maxX,
    minY: lockY ? Math.min(safeZoneBBoxPt.minY, bbox.minY) : safeZoneBBoxPt.minY,
    maxY: lockY ? Math.max(safeZoneBBoxPt.maxY, bbox.maxY) : safeZoneBBoxPt.maxY,
  };
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
  const autofixPlans = [];
  const fullyResolved = allSidesAllowed(allowedSides);

  if (geometry.trimBoxPt) {
    const zones = {
      trimBoxPt: geometry.trimBoxPt,
      safeZoneBBoxPt: geometry.safeZoneBBoxPt,
      bleedBoxPt: geometry.bleedBoxPt,
    };
    for (const obj of objects) {
      const conservativeViolations = classifyViolations(obj, zones, allowedSides);
      // CHECKPOINT 5C: split out AMBIGUOUS left/right LEM entries (see
      // splitAmbiguousViolations()'s own jsdoc) -- a no-op in 'exact' mode
      // or when geometry has no orientationHypotheses at all.
      const { finalViolations: objViolations, ambiguousEntries } = splitAmbiguousViolations(
        obj,
        conservativeViolations,
        geometry,
        pageIndex
      );
      for (const v of objViolations) {
        violations.push({ ...v, pageIndex });
      }
      for (const amb of ambiguousEntries) {
        manualReviewEntries.push(amb);
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

      // CHECKPOINT 4: plan autofix ONLY when every side's geometry is fully
      // resolved (see allSidesAllowed()'s jsdoc) and only for an object that
      // actually has something to plan for (a violation was found, or the
      // object is otherwise edge-touching -- planAutofix() decides that
      // internally; we simply never call it at all when geometry can't
      // safely support its internal arithmetic).
      if (fullyResolved && objViolations.length > 0) {
        // CHECKPOINT 5D fix: never let an autofix plan move an axis that
        // only has an AMBIGUOUS entry on it -- see lockAmbiguousAxes()'s
        // own jsdoc. A no-op (returns geometry.safeZoneBBoxPt unchanged)
        // whenever there's no ambiguous entry for this object at all,
        // exactly the D13/D14-style pure-definite case.
        const autofixSafeZoneBBoxPt = lockAmbiguousAxes(
          geometry.safeZoneBBoxPt,
          obj.visibleBBoxPt,
          ambiguousEntries,
          objViolations
        );
        const plan = planAutofix(obj, autofixSafeZoneBBoxPt, {
          pageBoxPt: geometry.trimBoxPt,
          bleedZoneBBoxPt: geometry.bleedBoxPt,
          violations: objViolations,
        });
        if (plan.status === 'autofix') {
          autofixPlans.push({
            pageIndex,
            type: obj.type,
            rawBBoxPt: obj.rawBBoxPt,
            visibleBBoxPt: obj.visibleBBoxPt,
            shift: plan.shift,
            fixedBBoxPt: plan.fixedBBoxPt,
            applyable: isByteApplyable(obj),
            applyableReason: isByteApplyable(obj)
              ? undefined
              : 'Безпечний план є, але v1 byte-rewriter не підтримує цей тип об’єкта (тільше прямокутник типу path, без clip/stroke).',
          });
        }
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
    autofixPlans,
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
    autofixPlans: pageResults.flatMap((p) => p.autofixPlans),
    verdict: computeVerdict(categories),
  };

  return result;
}

/**
 * CHECKPOINT 4: the authoritative check -> fix -> re-check loop.
 *
 * BEFORE = runPreflight(original); AFTER = runPreflight(fixed) -- runPreflight()
 * stays the single, unmodified source of compliance truth for both calls, per
 * the user's explicit instruction not to build a second verification system.
 *
 * Autofix is never considered to have succeeded merely because applyAutofix()
 * ran without throwing -- VERIFIED is only returned when the re-run AFTER
 * result actually shows the targeted problem gone, with no new violation and
 * no geometry regression. See lib/pdfAutofixWriter.js for the byte-level
 * patch step this wraps.
 *
 * @returns {Promise<{
 *   before: object, after: object|null, outputBytes: Uint8Array,
 *   applied: Array, skipped: Array,
 *   verification: 'VERIFIED' | 'MANUAL_REVIEW_REQUIRED',
 *   reasons: string[],
 * }>}
 */
/**
 * Pure comparison: given BEFORE/AFTER InspectionResults (both already
 * produced by runPreflight() -- this function never calls it, never loads
 * a PDF, and never guesses) plus what applyAutofix() actually did, decide
 * VERIFIED vs MANUAL_REVIEW_REQUIRED and why. Extracted as its own, directly
 * testable function (2026-10-05) specifically so the decision logic itself
 * can be exercised with hand-built before/after fixtures in tests, exactly
 * the way CHECKPOINT 3's Part A tested resolveAllowedSides() against
 * geometry shapes the real engine can't produce yet (today, the real
 * engine's horizontal-geometry limitation means genuine runPreflight() never
 * reaches the "had something to apply" branch at all -- see
 * allSidesAllowed()'s jsdoc -- so this function is what actually gets
 * exercised against a non-trivial before/after pair; verifyAutofix() itself
 * is exercised end-to-end against the one real, always-reachable branch:
 * "nothing applicable today").
 *
 * @param {object} before  runPreflight(original)
 * @param {object} after  runPreflight(fixed)
 * @param {Array<{plan: object, patch: object}>} applied
 * @param {Array<{plan: object, reason: string}>} skipped
 * @returns {{verification: 'VERIFIED'|'MANUAL_REVIEW_REQUIRED', reasons: string[]}}
 */
function evaluateVerification(before, after, applied, skipped) {
  const reasons = [];

  if (skipped.length > 0) reasons.push('AUTOFIX_NOT_SAFELY_APPLICABLE');

  const afterGeometryUnresolved = after.geometry.pages.some((p) => anySideBlocked(p.allowedSides));
  if (afterGeometryUnresolved) reasons.push('GEOMETRY_UNRESOLVED');

  // The problem each applied plan targeted must actually be gone: its
  // (pageIndex, rawBBoxPt) must no longer appear among AFTER's violations
  // on that page (matched by rawBBoxPt -- a successfully-shifted object now
  // sits at a different bbox entirely, so finding its OLD bbox again means
  // either the shift didn't take or something re-created the problem).
  const stillPresent = applied.some(({ plan }) =>
    after.violations.some(
      (v) => v.pageIndex === plan.pageIndex && bboxesApproxEqual(v.rawBBoxPt, plan.rawBBoxPt, RECT_MATCH_EPSILON_PT)
    )
  );
  if (stillPresent) reasons.push('ISSUE_REMAINS');

  // New violations appearing after the fix that weren't present before, net
  // of however many the applied plans themselves were expected to remove,
  // would mean the patch disturbed something else on the page -- a coarse
  // but honest per-page count comparison (never silently assume "it's
  // fine").
  const beforeCountByPage = new Map();
  for (const v of before.violations) {
    beforeCountByPage.set(v.pageIndex, (beforeCountByPage.get(v.pageIndex) || 0) + 1);
  }
  const appliedCountByPage = new Map();
  for (const { plan } of applied) {
    appliedCountByPage.set(plan.pageIndex, (appliedCountByPage.get(plan.pageIndex) || 0) + 1);
  }
  const afterCountByPage = new Map();
  for (const v of after.violations) {
    afterCountByPage.set(v.pageIndex, (afterCountByPage.get(v.pageIndex) || 0) + 1);
  }
  let newViolationsAppeared = false;
  for (const [pageIndex, beforeCount] of beforeCountByPage) {
    const appliedCount = appliedCountByPage.get(pageIndex) || 0;
    const afterCount = afterCountByPage.get(pageIndex) || 0;
    if (afterCount > beforeCount - appliedCount) newViolationsAppeared = true;
  }
  // Pages with no BEFORE violations at all, but a new one after the fix.
  for (const [pageIndex, afterCount] of afterCountByPage) {
    if (!beforeCountByPage.has(pageIndex) && afterCount > 0) newViolationsAppeared = true;
  }
  if (newViolationsAppeared) reasons.push('NEW_VIOLATIONS_AFTER_FIX');

  // CHECKPOINT 5E audit fix (BLOCKER): the four checks above are all
  // derived from `violations[]`/`geometry` counts and bbox matching alone
  // -- none of them inspect `after.verdict` or `after.categories.margins
  // .manualReview[]` directly. Two concrete, empirically-confirmed
  // contradictions follow from that gap:
  //   1. an LEM_ORIENTATION_AMBIGUOUS entry never enters `violations[]` at
  //      all (splitAmbiguousViolations() routes it to manualReview[]
  //      exclusively), so it is invisible to every check above even when
  //      it is the ONLY thing keeping the document out of READY.
  //   2. a pre-existing, untouched violation on the SAME page as a
  //      successfully-applied, unrelated fix can escape
  //      `newViolationsAppeared`'s per-page NET COUNT comparison when the
  //      fixed-and-removed violation's count happens to arithmetically
  //      cancel out the untouched-and-remaining one.
  // Both are closed by one direct, authoritative check: `after` is itself
  // a full runPreflight() result (the same, single source of compliance
  // truth this whole function already trusts for every other field), so
  // `after.verdict !== 'READY'` is already the correct, aggregate answer
  // to "can the engine confirm this is safe to export now" -- it doesn't
  // need to be re-derived from violations[]/geometry counts, and adding it
  // does not introduce a second compliance engine. The four checks above
  // are kept alongside it (not replaced) because they still give more
  // specific, user-facing reason codes than a bare "verdict isn't READY"
  // would on its own.
  if (after.verdict !== 'READY') reasons.push('MANUAL_REVIEW_REMAINS');

  return { verification: reasons.length === 0 ? 'VERIFIED' : 'MANUAL_REVIEW_REQUIRED', reasons };
}

/**
 * CHECKPOINT 4: the authoritative check -> fix -> re-check loop.
 *
 * BEFORE = runPreflight(original); AFTER = runPreflight(fixed) -- runPreflight()
 * stays the single, unmodified source of compliance truth for both calls, per
 * the user's explicit instruction not to build a second verification system.
 *
 * Autofix is never considered to have succeeded merely because applyAutofix()
 * ran without throwing -- VERIFIED is only returned when the re-run AFTER
 * result actually shows the targeted problem gone, with no new violation and
 * no geometry regression (see evaluateVerification() above for exactly what
 * that checks). See lib/pdfAutofixWriter.js for the byte-level patch step
 * this wraps.
 *
 * @returns {Promise<{
 *   before: object, after: object|null, outputBytes: Uint8Array,
 *   applied: Array, skipped: Array,
 *   verification: 'VERIFIED' | 'MANUAL_REVIEW_REQUIRED',
 *   reasons: string[],
 * }>}
 */
async function verifyAutofix(pdfBytes, opts = {}) {
  // Loaded lazily (not at module scope): this file's runPreflight() is the
  // AFTER check lib/pdfAutofixWriter.js never performs itself -- keeping
  // this require local documents that THIS function, not that module, owns
  // the re-verification step. (No actual require cycle either way: that
  // module does not import this one.)
  const { applyAutofix } = require('./pdfAutofixWriter');

  const before = await runPreflight(pdfBytes, opts);
  const applyablePlans = (before.autofixPlans || []).filter((p) => p.applyable);

  if (applyablePlans.length === 0) {
    // Nothing this engine can physically autofix today -- the ORIGINAL
    // bytes are the only bytes that exist; verification can only reflect
    // whatever runPreflight(original) already found. Never claim VERIFIED
    // for a document whose own BEFORE verdict wasn't already READY.
    const reasons = [];
    if (before.verdict !== 'READY') reasons.push('NO_APPLICABLE_AUTOFIX');
    return {
      before,
      after: null,
      outputBytes: pdfBytes,
      applied: [],
      skipped: [],
      verification: reasons.length === 0 ? 'VERIFIED' : 'MANUAL_REVIEW_REQUIRED',
      reasons,
    };
  }

  const { outputBytes, applied, skipped } = await applyAutofix(pdfBytes, before);
  const after = await runPreflight(outputBytes, opts);
  const { verification, reasons } = evaluateVerification(before, after, applied, skipped);

  return { before, after, outputBytes, applied, skipped, verification, reasons };
}

module.exports = {
  runPreflight,
  verifyAutofix,
  evaluateVerification,
  resolveAllowedSides,
  isResolvedNumber,
};
