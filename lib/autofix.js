/**
 * Margin/LEM autofix — "Layout Normalization" / "Smart Margin Pad".
 *
 * Agreed rule (Claude + Gemini + Volodymyr, 2026-10-04):
 *   - Graphics/background objects (type 'path' or 'image') with a SMALL
 *     safe-zone violation (<= THRESHOLD_IN, 0.1in) get an automatic
 *     proportional SHIFT — never a distorting scale — that moves them
 *     back inside the safe zone.
 *   - Anything bigger than the threshold, or any TEXT ('text' type)
 *     violation of any size, is NEVER auto-corrected. It is flagged for
 *     manual review in the UI instead, so the user's layout is never
 *     silently altered where a human judgment call is actually needed.
 */

'use strict';

const { intersectBBox } = require('./margin');
const { LEM_AUTOFIX_THRESHOLD_PT, exceedsAutofixThreshold } = require('./marginPolicy');

// THRESHOLD_IN/THRESHOLD_PT are kept as named exports for backward
// compatibility (existing tests log/reference them) but are now sourced
// from lib/marginPolicy.js -- the single shared definition of this
// threshold, used by both this file's planAutofix() and lib/margin.js's
// classifyViolations(). Extracted 2026-10-05 after the detection/autofix
// reconciliation pass found the two files disagreeing at the exact
// threshold boundary due to float noise (see marginPolicy.js's header).
const THRESHOLD_IN = 0.1;
const THRESHOLD_PT = LEM_AUTOFIX_THRESHOLD_PT; // 7.2pt

function bboxWidth(b) {
  return b.maxX - b.minX;
}
function bboxHeight(b) {
  return b.maxY - b.minY;
}

/**
 * Compute the shift (dx, dy) that would move `bbox` fully inside
 * `safeZoneBBoxPt`, or null if the object can't be shift-fixed at all
 * (it's wider/taller than the zone itself — no translation can fix that).
 */
function computeShiftToFit(bbox, safeZoneBBoxPt) {
  if (bboxWidth(bbox) > bboxWidth(safeZoneBBoxPt) || bboxHeight(bbox) > bboxHeight(safeZoneBBoxPt)) {
    return null; // object itself is bigger than the zone — shifting can't fix this
  }

  let dx = 0;
  if (bbox.minX < safeZoneBBoxPt.minX) dx = safeZoneBBoxPt.minX - bbox.minX;
  else if (bbox.maxX > safeZoneBBoxPt.maxX) dx = safeZoneBBoxPt.maxX - bbox.maxX;

  let dy = 0;
  if (bbox.minY < safeZoneBBoxPt.minY) dy = safeZoneBBoxPt.minY - bbox.minY;
  else if (bbox.maxY > safeZoneBBoxPt.maxY) dy = safeZoneBBoxPt.maxY - bbox.maxY;

  return { dx, dy };
}

function shiftBBox(bbox, dx, dy) {
  return { minX: bbox.minX + dx, minY: bbox.minY + dy, maxX: bbox.maxX + dx, maxY: bbox.maxY + dy };
}

// Gemini review point (2026-10-04, Margin/Bleed/LEM closeout): shifting a
// full-bleed background to close a gap on one side can open a gap on the
// OPPOSITE side — the exact "silent layout damage" the whole project is
// meant to prevent. So an object that spans the page (edge to edge on at
// least one axis — the hallmark of a bleed background, not a foreground
// element meant to respect the LEM) is NEVER routed through the ordinary
// shift-based autofix. It is checked against bleed-coverage instead, and
// any gap there goes straight to manual review — proportional scale-to-fit
// is the correct automatic fix for that case, per the master plan, but is
// left as a backlog item for now rather than rushed in here.
const EDGE_TOUCH_TOLERANCE_PT = 1;

/**
 * Which page edges does this object already touch or cross? Touching EVEN
 * ONE edge is enough to disqualify it from ordinary shift-autofix — an
 * object bleeding off only the left edge (common: a half-page design
 * element, not just full-width backgrounds) is just as much at risk of
 * having that correct edge pulled away by a shift meant to fix something
 * else, as a full-width background is.
 */
function touchedPageEdges(bbox, pageBoxPt) {
  return {
    left: bbox.minX <= pageBoxPt.minX + EDGE_TOUCH_TOLERANCE_PT,
    right: bbox.maxX >= pageBoxPt.maxX - EDGE_TOUCH_TOLERANCE_PT,
    bottom: bbox.minY <= pageBoxPt.minY + EDGE_TOUCH_TOLERANCE_PT,
    top: bbox.maxY >= pageBoxPt.maxY - EDGE_TOUCH_TOLERANCE_PT,
  };
}

function anyEdgeTouched(touched) {
  return touched.left || touched.right || touched.bottom || touched.top;
}

/**
 * Check bleed coverage only on the edges the object actually touches —
 * never proposes a shift, only "safe" or "manual_review", because a shift
 * here is exactly the move that risks opening a gap on an edge that was
 * already correct.
 */
function checkBleedCoverage(bbox, bleedZoneBBoxPt, touched) {
  const gaps = [];
  if (touched.left && bbox.minX > bleedZoneBBoxPt.minX) gaps.push(`зліва (${((bbox.minX - bleedZoneBBoxPt.minX) / 72).toFixed(3)}in)`);
  if (touched.right && bbox.maxX < bleedZoneBBoxPt.maxX) gaps.push(`справа (${((bleedZoneBBoxPt.maxX - bbox.maxX) / 72).toFixed(3)}in)`);
  if (touched.bottom && bbox.minY > bleedZoneBBoxPt.minY) gaps.push(`знизу (${((bbox.minY - bleedZoneBBoxPt.minY) / 72).toFixed(3)}in)`);
  if (touched.top && bbox.maxY < bleedZoneBBoxPt.maxY) gaps.push(`зверху (${((bleedZoneBBoxPt.maxY - bbox.maxY) / 72).toFixed(3)}in)`);
  if (gaps.length === 0) return { status: 'safe' };
  return {
    status: 'manual_review',
    reason: `Елемент, що виходить за край сторінки, не дотягує до bleed-зони: ${gaps.join(', ')}. Автозсув заборонено (ризик оголити інший, вже коректний край) — потрібне пропорційне розширення (беклог) або ручне виправлення.`,
  };
}

/**
 * Decide what to do about one detected object relative to a safe zone
 * (typically the LEM boundary).
 *
 * @param {{type: string, visibleBBoxPt: object}} obj  one entry from
 *   analyzeOperatorList()'s results
 * @param {{minX,minY,maxX,maxY}} safeZoneBBoxPt
 * @param {{pageBoxPt?: object, bleedZoneBBoxPt?: object, violations?: Array}} [opts]
 *   pass pageBoxPt+bleedZoneBBoxPt to enable the full-bleed-background
 *   guard above; without them, an object that spans the page is treated
 *   like any other shape (the old, narrower behavior — kept only for
 *   callers not yet passing page/bleed info, not recommended).
 *
 *   opts.violations (OPTIONAL, added 2026-10-05 per the edge-touch +
 *   untouched-side-LEM validation checkpoint): the SAME per-side
 *   violations array lib/margin.js's classifyViolations(obj, zones)
 *   already produced for this exact obj, passed through as-is — this
 *   function does not recompute or re-derive it, only cross-references
 *   each entry's `side` against the `touched` sides it already computed
 *   for the bleed-guard above. Fixes a real false-negative: without this
 *   field, the instant ANY side touches the trim boundary, this function
 *   decides the WHOLE object purely from checkBleedCoverage() — which
 *   only checks gaps on the TOUCHED sides — and returns 'safe' even when
 *   a genuine LEM (or, in principle, BLEED — see below) violation exists
 *   on a different, untouched side that was never examined. When
 *   opts.violations is omitted, behavior is UNCHANGED from before this
 *   field existed (every existing caller/test that doesn't pass it keeps
 *   its exact prior result). A BLEED violation geometrically cannot land
 *   on a side touchedPageEdges() considers untouched — classifyViolations'
 *   own TOLERANCE_PT (0.5pt) for "past trim" is always tighter than this
 *   file's EDGE_TOUCH_TOLERANCE_PT (1pt) for "touches trim" on the same
 *   trim boundary — so in practice this override only ever fires for LEM,
 *   but the check isn't hardcoded to LEM specifically, to stay correct
 *   even if that relationship ever changes.
 *
 *   NAMING NOTE (found during the detection/autofix reconciliation pass,
 *   2026-10-05, not fixed yet — deferred on purpose): despite its name,
 *   `pageBoxPt` is used here purely as "the TRIM boundary" — every
 *   existing caller/test passes a trim-sized box, and `bleedZoneBBoxPt`
 *   as that same box expanded outward by the bleed allowance
 *   (touchedPageEdges()/checkBleedCoverage() just compare raw numbers
 *   against whatever they're given, so this works correctly regardless
 *   of the name). The name dates from when this file assumed a PDF's
 *   actual MediaBox was sized at trim only. It is geometrically
 *   identical to lib/margin.js's/test/zones.js's `trimBoxPt`. Rename
 *   `pageBoxPt` -> `trimBoxPt` the next time this file is substantially
 *   touched; not renamed now to keep this change scoped to the shared
 *   threshold helper only.
 * @returns {{
 *   status: 'safe' | 'autofix' | 'manual_review',
 *   reason?: string,
 *   shift?: {dx: number, dy: number},
 *   fixedBBoxPt?: object,
 * }}
 */
function planAutofix(obj, safeZoneBBoxPt, opts = {}) {
  const bbox = obj.visibleBBoxPt;

  if (obj.type !== 'text' && opts.pageBoxPt) {
    const touched = touchedPageEdges(bbox, opts.pageBoxPt);
    if (anyEdgeTouched(touched)) {
      if (!opts.bleedZoneBBoxPt) {
        // No bleed zone given — safest default is to not guess; don't shift.
        return { status: 'manual_review', reason: 'Об’єкт торкається краю сторінки — потрібна bleed-зона для коректної перевірки, автозсув заборонено.' };
      }
      const bleedResult = checkBleedCoverage(bbox, opts.bleedZoneBBoxPt, touched);

      // opts.violations override (see jsdoc above): checkBleedCoverage()
      // only looked at the TOUCHED sides. Before trusting a 'safe' from
      // it, check whether the caller's already-computed per-side
      // violations list (classifyViolations' own output for this same
      // obj) reports anything on a side that check never examined.
      if (bleedResult.status === 'safe' && opts.violations) {
        const untouchedViolation = opts.violations.find((v) => !touched[v.side]);
        if (untouchedViolation) {
          return {
            status: 'manual_review',
            reason: `Об’єкт торкається краю сторінки й там коректно покритий bleed-зоною, але має окреме порушення (${untouchedViolation.violation}, ${untouchedViolation.amountPt.toFixed(2)}pt) на стороні "${untouchedViolation.side}", яку перевірка bleed-покриття не розглядає — потрібне ручне рішення.`,
          };
        }
      }

      return bleedResult;
    }
  }

  // Already inside the zone — nothing to do.
  const inside = intersectBBox(bbox, safeZoneBBoxPt);
  const alreadySafe =
    inside &&
    !inside.empty &&
    Math.abs(inside.minX - bbox.minX) < 1e-6 &&
    Math.abs(inside.minY - bbox.minY) < 1e-6 &&
    Math.abs(inside.maxX - bbox.maxX) < 1e-6 &&
    Math.abs(inside.maxY - bbox.maxY) < 1e-6;
  if (alreadySafe) {
    return { status: 'safe' };
  }

  // Text is never auto-corrected, regardless of how small the violation
  // is — a shifted line of text can break the whole page's visual grid.
  if (obj.type === 'text') {
    return { status: 'manual_review', reason: 'Текстовий об’єкт порушує LEM — потрібне ручне рішення, автозсув тексту заборонено.' };
  }

  const shift = computeShiftToFit(bbox, safeZoneBBoxPt);
  if (!shift) {
    return { status: 'manual_review', reason: 'Об’єкт більший за безпечну зону — зсув геометрично неможливий.' };
  }

  const magnitude = Math.max(Math.abs(shift.dx), Math.abs(shift.dy));
  // exceedsAutofixThreshold() (lib/marginPolicy.js), not a raw `>
  // THRESHOLD_PT` compare -- the shared helper carries the float-noise
  // epsilon that this exact comparison was missing before 2026-10-05's
  // reconciliation pass (see marginPolicy.js's header for why that
  // mattered: this file and lib/margin.js disagreed at the exact 0.1in
  // boundary purely from binary floating-point subtraction noise).
  if (exceedsAutofixThreshold(magnitude)) {
    return {
      status: 'manual_review',
      reason: `Потрібне зміщення ${(magnitude / 72).toFixed(3)}in перевищує порог автофіксу ${THRESHOLD_IN}in.`,
    };
  }

  return {
    status: 'autofix',
    shift,
    fixedBBoxPt: shiftBBox(bbox, shift.dx, shift.dy),
  };
}

/** Run planAutofix over a whole analyzeOperatorList() result set. */
function planAutofixForPage(detectedObjects, safeZoneBBoxPt, opts) {
  return detectedObjects.map((obj) => ({ obj, plan: planAutofix(obj, safeZoneBBoxPt, opts) }));
}

module.exports = {
  planAutofix,
  planAutofixForPage,
  computeShiftToFit,
  touchedPageEdges,
  THRESHOLD_IN,
  THRESHOLD_PT,
};
