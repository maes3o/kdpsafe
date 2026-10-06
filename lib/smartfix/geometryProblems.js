'use strict';

/**
 * Smart Fix Phase 1 — page-geometry problem detection. Read-only: every
 * function here only reads pdf-lib box/rotation data and
 * manuscript.js's already-existing output; nothing is mutated, and
 * nothing in lib/manuscript.js, lib/zones.js or lib/margin.js is edited
 * or forked — their exported constants/functions are used exactly as
 * already exported.
 *
 * Scope, deliberately narrow for Phase 1 (per smart-fix-engine-mvp-
 * architecture.md's build order and the explicit "SAFETY OVER COVERAGE"
 * instruction for this checkpoint):
 *
 *   - Non-zero /Rotate            -> always a PageGeometryProblem that
 *     forces MANUAL_REVIEW. The rotation-aware geometry adapter (A5 in
 *     smart-fix-engine-gap-closure.md) that would let BOX_NORMALIZATION/
 *     PADDING reason correctly about a rotated page is explicitly NOT
 *     built in this phase — rather than guess, every rotated page is
 *     routed to manual review.
 *   - Non-zero MediaBox origin    -> same treatment: PADDING's content-
 *     stream transform math (not built in Phase 1 either, since Phase 1
 *     is plan-only) would need to account for it; until that exists, a
 *     non-zero origin is a MANUAL_REVIEW problem, not a silently-ignored
 *     detail.
 *   - Explicit /TrimBox or /BleedBox that CONFLICTS with the user's
 *     confirmed intent -> MANUAL_REVIEW (ambiguous: is the box stale, or
 *     is the user's stated intent wrong? Phase 1 never guesses).
 *   - Page smaller than or equal to the target on every axis (and not
 *     already exact) -> TOO_SMALL, the one case PADDING can safely
 *     handle (it only ever adds blank canvas, never scales, so aspect
 *     ratio is irrelevant to its safety — see smart-fix-engine-research
 *     .md §3.2/§4).
 *   - Page larger than the target on ANY axis, in any combination
 *     (uniformly too large, or mixed growth/shrink) -> intentionally
 *     NOT handled by any Phase 1 strategy (that is PROPORTIONAL_SCALE/
 *     SCALE_PLUS_PADDING/SAFE_CROP territory, out of scope this phase)
 *     -> MANUAL_REVIEW.
 *   - Already exact match, with consistent (or absent) TrimBox/BleedBox
 *     -> no problem; BOX_NORMALIZATION is only ever proposed when the
 *     page is ALREADY the right size and only its box dictionary is
 *     missing/needs declaring.
 */

const { PDFDocument } = require('pdf-lib');
const { inspectManuscript } = require('../manuscript');
const { TOLERANCE_PT } = require('../margin');
const { inToPt, BLEED_OUTER_IN, BLEED_TOP_IN, BLEED_BOTTOM_IN } = require('../zones');

/**
 * Computes the target page dimensions (trim, or trim+bleed per the KDP
 * bleed formula already encoded in lib/zones.js) in points. This is the
 * SAME formula lib/zones.js's own checkBleedBoxConsistency() already uses
 * for its "does this BleedBox look like trim+bleed" comparison — reused
 * here as exported constants, never re-derived independently.
 *
 * @returns {{ widthPt: number, heightPt: number } | null} null when
 *   userIntent itself is insufficient to determine a target at all —
 *   Smart Fix must never guess a trim size or a bleed choice.
 */
function computeTargetDimsPt(userIntent) {
  const intent = userIntent || {};
  const trimSize = intent.trimSize;
  if (!trimSize || typeof trimSize.widthIn !== 'number' || typeof trimSize.heightIn !== 'number') {
    return null;
  }
  if (typeof intent.bleed !== 'boolean') {
    return null;
  }

  const trimWidthPt = inToPt(trimSize.widthIn);
  const trimHeightPt = inToPt(trimSize.heightIn);

  if (!intent.bleed) {
    return { widthPt: trimWidthPt, heightPt: trimHeightPt };
  }

  return {
    widthPt: trimWidthPt + inToPt(BLEED_OUTER_IN),
    heightPt: trimHeightPt + inToPt(BLEED_TOP_IN) + inToPt(BLEED_BOTTOM_IN),
  };
}

function approxEqual(a, b, epsilon) {
  return Math.abs(a - b) <= epsilon;
}

/**
 * Reads the raw pdf-lib box/rotation facts for one page — deliberately a
 * fresh, independent read (not a call into lib/orchestrator.js's own
 * extractPdfBoxes(), which is not exported), but using the exact same,
 * already-established pattern: node.TrimBox()/node.BleedBox() to detect
 * TRUE ABSENCE (never defaulted to MediaBox, unlike pdf-lib's own
 * getTrimBox()/getBleedBox(), which silently inherit MediaBox per the PDF
 * spec when the key is missing).
 */
function readPageBoxInfo(page) {
  const hasExplicitTrimBox = page.node.TrimBox() !== undefined;
  const hasExplicitBleedBox = page.node.BleedBox() !== undefined;
  const mediaBox = page.getMediaBox();
  const rotation = page.getRotation();

  return {
    mediaBox,
    rotationDeg: rotation ? rotation.angle : 0,
    trimBox: hasExplicitTrimBox ? page.getTrimBox() : null,
    bleedBox: hasExplicitBleedBox ? page.getBleedBox() : null,
  };
}

/**
 * Compares an explicit box's dimensions against an expected {widthPt,
 * heightPt}. Returns 'absent' | 'consistent' | 'conflict' — position is
 * never compared (matching lib/zones.js's own checkTrimBoxConsistency()
 * precedent: dimensions only).
 */
function checkBoxDims(box, expectedPt) {
  if (!box) return 'absent';
  const widthOk = approxEqual(box.width, expectedPt.widthPt, TOLERANCE_PT);
  const heightOk = approxEqual(box.height, expectedPt.heightPt, TOLERANCE_PT);
  return widthOk && heightOk ? 'consistent' : 'conflict';
}

/**
 * Per-page geometry analysis — the one object repairPlanner.js and the
 * Phase 1 strategy modules read from. Deliberately a narrower,
 * Phase-1-scoped version of the full `PageAnalysis` shape described in
 * smart-fix-engine-mvp-architecture.md §2.3 (no annotations/clip/text/DPI
 * fields — those analyzers are not built this phase).
 *
 * @typedef {object} PageGeometryAnalysis
 * @property {number} pageIndex
 * @property {{widthIn:number,heightIn:number}} measured
 * @property {number} rotationDeg
 * @property {boolean} nonZeroOrigin
 * @property {{status:string}} trimBoxCheck   'absent'|'consistent'|'conflict'
 * @property {{status:string}} bleedBoxCheck  'absent'|'consistent'|'conflict' (only meaningful when intent.bleed)
 * @property {{widthPt:number,heightPt:number}|null} target
 * @property {number|null} deltaWidthPt   measured - target, in points (null if target unknown)
 * @property {number|null} deltaHeightPt
 * @property {'EXACT'|'TOO_SMALL'|'NOT_SAFE_FOR_PHASE1'|'TARGET_UNKNOWN'} sizeRelation
 * @property {import('./types').PageGeometryProblem|null} problem
 */

/**
 * @param {Uint8Array} pdfBytes
 * @param {{trimSize:{widthIn:number,heightIn:number}, bleed:boolean}} userIntent
 * @returns {Promise<{ pageCount: number, pageSizeConsistent: boolean, pages: PageGeometryAnalysis[] }>}
 */
async function analyzeDocumentGeometry(pdfBytes, userIntent) {
  const manuscript = await inspectManuscript(pdfBytes);
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pdfPages = doc.getPages();
  const targetPt = computeTargetDimsPt(userIntent);

  const pages = pdfPages.map((page, pageIndex) => {
    const boxInfo = readPageBoxInfo(page);
    const measured = manuscript.pageSizes[pageIndex];
    const measuredWidthPt = measured.widthIn * 72;
    const measuredHeightPt = measured.heightIn * 72;

    const nonZeroOrigin = !approxEqual(boxInfo.mediaBox.x, 0, TOLERANCE_PT) || !approxEqual(boxInfo.mediaBox.y, 0, TOLERANCE_PT);

    let trimBoxStatus = 'absent';
    let bleedBoxStatus = 'absent';
    if (targetPt) {
      trimBoxStatus = checkBoxDims(boxInfo.trimBox, targetPt);
      // BleedBox is only meaningfully checked when bleed was requested —
      // when bleed is false, a present BleedBox is a separate consistency
      // question lib/zones.js already raises elsewhere; Phase 1 Smart Fix
      // does not re-litigate that here, it only checks consistency
      // against the box it would itself need to write.
      if (userIntent && userIntent.bleed) {
        bleedBoxStatus = checkBoxDims(boxInfo.bleedBox, {
          widthPt: targetPt.widthPt,
          heightPt: targetPt.heightPt,
        });
      } else {
        bleedBoxStatus = 'absent';
      }
    }

    let sizeRelation = 'TARGET_UNKNOWN';
    let deltaWidthPt = null;
    let deltaHeightPt = null;
    let problem = null;

    if (targetPt) {
      deltaWidthPt = measuredWidthPt - targetPt.widthPt;
      deltaHeightPt = measuredHeightPt - targetPt.heightPt;

      const widthExact = approxEqual(deltaWidthPt, 0, TOLERANCE_PT);
      const heightExact = approxEqual(deltaHeightPt, 0, TOLERANCE_PT);
      const widthWithinOrEqual = deltaWidthPt <= TOLERANCE_PT;
      const heightWithinOrEqual = deltaHeightPt <= TOLERANCE_PT;

      if (widthExact && heightExact) {
        sizeRelation = 'EXACT';
      } else if (widthWithinOrEqual && heightWithinOrEqual) {
        sizeRelation = 'TOO_SMALL';
      } else {
        sizeRelation = 'NOT_SAFE_FOR_PHASE1';
      }
    }

    // --- Build the PageGeometryProblem (diagnostic-facing), independent
    // of what strategy (if any) Phase 1 can safely propose for it. ---
    if (boxInfo.rotationDeg !== 0) {
      problem = {
        pageIndex,
        kind: 'NON_ZERO_ROTATION',
        detail: `Сторінка має /Rotate=${boxInfo.rotationDeg}. Phase 1 Smart Fix не містить rotation-aware геометричного адаптера — жодна стратегія не пропонується, доки ротація не оброблена окремо.`,
        measured: { widthIn: measured.widthIn, heightIn: measured.heightIn },
        expected: targetPt ? { widthIn: targetPt.widthPt / 72, heightIn: targetPt.heightPt / 72 } : { widthIn: null, heightIn: null },
      };
    } else if (nonZeroOrigin) {
      problem = {
        pageIndex,
        kind: 'NON_ZERO_ORIGIN',
        detail: `MediaBox має ненульове походження (x=${boxInfo.mediaBox.x}, y=${boxInfo.mediaBox.y}). Phase 1 не містить content-translation writer — жодна стратегія не пропонується.`,
        measured: { widthIn: measured.widthIn, heightIn: measured.heightIn },
        expected: targetPt ? { widthIn: targetPt.widthPt / 72, heightIn: targetPt.heightPt / 72 } : { widthIn: null, heightIn: null },
      };
    } else if (trimBoxStatus === 'conflict' || bleedBoxStatus === 'conflict') {
      problem = {
        pageIndex,
        kind: 'BOX_CONFLICT',
        detail:
          trimBoxStatus === 'conflict'
            ? 'Явний /TrimBox за розмірами не відповідає підтвердженому trim size користувача — неоднозначно, тому нічого не виправляється автоматично.'
            : 'Явний /BleedBox за розмірами не відповідає очікуваній bleed-геометрії — неоднозначно, тому нічого не виправляється автоматично.',
        measured: { widthIn: measured.widthIn, heightIn: measured.heightIn },
        expected: targetPt ? { widthIn: targetPt.widthPt / 72, heightIn: targetPt.heightPt / 72 } : { widthIn: null, heightIn: null },
      };
    } else if (sizeRelation === 'TARGET_UNKNOWN') {
      problem = {
        pageIndex,
        kind: 'MISSING_TRIM_BOX',
        detail: 'userIntent.trimSize/bleed відсутній або некоректний — цільовий розмір сторінки визначити неможливо.',
        measured: { widthIn: measured.widthIn, heightIn: measured.heightIn },
        expected: { widthIn: null, heightIn: null },
      };
    } else if (sizeRelation === 'TOO_SMALL') {
      problem = {
        pageIndex,
        kind: 'TOO_SMALL',
        detail: 'Сторінка менша (або рівна) за цільовий розмір на кожній осі.',
        measured: { widthIn: measured.widthIn, heightIn: measured.heightIn },
        expected: { widthIn: targetPt.widthPt / 72, heightIn: targetPt.heightPt / 72 },
      };
    } else if (sizeRelation === 'NOT_SAFE_FOR_PHASE1') {
      problem = {
        pageIndex,
        kind: deltaWidthPt > TOLERANCE_PT && deltaHeightPt > TOLERANCE_PT ? 'TOO_LARGE' : 'WRONG_ASPECT',
        detail:
          'Сторінка більша за цільовий розмір на принаймні однiй осі (або змішане збільшення/зменшення). PROPORTIONAL_SCALE/SCALE_PLUS_PADDING/SAFE_CROP не входять у Phase 1 — потрібен ручний розгляд.',
        measured: { widthIn: measured.widthIn, heightIn: measured.heightIn },
        expected: { widthIn: targetPt.widthPt / 72, heightIn: targetPt.heightPt / 72 },
      };
    }
    // sizeRelation === 'EXACT' with consistent/absent boxes -> problem
    // stays null: the page is already compliant, nothing to flag.

    return {
      pageIndex,
      measured: { widthIn: measured.widthIn, heightIn: measured.heightIn },
      rotationDeg: boxInfo.rotationDeg,
      nonZeroOrigin,
      trimBoxCheck: { status: trimBoxStatus },
      bleedBoxCheck: { status: bleedBoxStatus },
      target: targetPt,
      deltaWidthPt,
      deltaHeightPt,
      sizeRelation,
      problem,
    };
  });

  return {
    pageCount: manuscript.pageCount,
    pageSizeConsistent: manuscript.pageSizeConsistent,
    pages,
  };
}

module.exports = {
  analyzeDocumentGeometry,
  computeTargetDimsPt,
};
