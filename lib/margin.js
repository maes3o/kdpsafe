/**
 * Margin / Bleed / LEM content-stream analysis — PROTOTYPE.
 *
 * Per the joint architecture review (Claude + Gemini, 2026-10-04):
 *   - Detection uses PDF.js (`getOperatorList`, recursing into Form XObjects)
 *     instead of a hand-rolled operator parser — PDF's CTM/graphics-state
 *     rules are too easy to get subtly wrong by hand.
 *   - The highest-risk piece, called out by Gemini, is clipping paths: an
 *     object's raw path bbox can extend into an unsafe zone while its
 *     VISIBLE (clipped) extent is safe — and KDP only cares about what's
 *     visible. This prototype exists to validate that specific logic
 *     before the rest of the module is built on top of it.
 *
 * Scope of this prototype: axis-aligned clip rectangles only (the common
 * case for cover/margin guides). Arbitrary polygon clip paths and
 * non-rectangular `re`+`clip` combinations are a known follow-up, not
 * handled here yet.
 */

'use strict';

// pdfjs-dist v6 ships ESM only (no CJS/legacy build) — load it lazily via
// dynamic import from this CommonJS module and cache the module object.
let _pdfjsLibPromise = null;
function loadPdfjs() {
  if (!_pdfjsLibPromise) {
    _pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return _pdfjsLibPromise;
}

/**
 * Multiply two 2D affine matrices in PDF's [a b c d e f] form.
 * m2 is applied first, then m1 (i.e. result = m1 * m2, matching PDF's
 * "cm" semantics where the new CTM = new matrix * old CTM).
 */
function matMul(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function applyMatToPoint(m, x, y) {
  const [a, b, c, d, e, f] = m;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/** Transform an axis-aligned rect by a matrix, returning its new axis-aligned bbox. */
function transformRectBBox(rect, m) {
  const pts = [
    applyMatToPoint(m, rect.x, rect.y),
    applyMatToPoint(m, rect.x + rect.width, rect.y),
    applyMatToPoint(m, rect.x, rect.y + rect.height),
    applyMatToPoint(m, rect.x + rect.width, rect.y + rect.height),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** Intersection of two bboxes in {minX,minY,maxX,maxY} form, or null if empty. */
function intersectBBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  if (minX >= maxX || minY >= maxY) return { minX, minY, maxX: minX, maxY: minY, empty: true };
  return { minX, minY, maxX, maxY };
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

// Gemini's second review point: Adobe-exported clip masks can sit a hair
// (sub-millimeter) outside their intended bounds. A small tolerance here
// avoids flagging a perfectly fine file as unsafe due to float/export noise.
// 0.5pt ~= 0.007in ~= 0.18mm — comfortably below anything a human would
// notice, but enough to absorb export rounding.
const TOLERANCE_PT = 0.5;

/** Approximate ascent/descent as a fraction of font size (no embedded font
 * metrics available from the operator list alone — flagged as approximate,
 * same as Gemini's tolerance point: good enough to decide safe/unsafe, not
 * a typographic-precision measurement). */
const APPROX_ASCENT_RATIO = 0.8;
const APPROX_DESCENT_RATIO = 0.2;

/**
 * Replay an operator list, tracking the CTM and the active clip bbox
 * (axis-aligned approximation), and return the visible (clip-intersected)
 * bbox of every fill/stroke/image op encountered.
 *
 * @returns {Array<{type: string, rawBBoxPt: object, visibleBBoxPt: object|null}>}
 */
function transformBBoxMinMax(b, m) {
  const corners = [
    applyMatToPoint(m, b.minX, b.minY),
    applyMatToPoint(m, b.maxX, b.minY),
    applyMatToPoint(m, b.minX, b.maxY),
    applyMatToPoint(m, b.maxX, b.maxY),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/*
 * IMPORTANT (found while building this prototype, not assumed up front):
 * PDF.js (v6, as installed) does NOT emit the textbook OPS.rectangle +
 * OPS.fill pair for a simple filled/clipped rectangle. Consecutive path
 * construction + paint calls are folded into a single `constructPath` op
 * whose args are [opCode, flattenedPoints, minMaxBBox] — and `minMaxBBox`
 * ([minX, minY, maxX, maxY], as a 4-entry array-like) is already the bbox
 * of that path, computed by PDF.js itself. There is no separate OPS.fill
 * call following it. A preceding `OPS.clip`/`OPS.eoClip` marker (with no
 * args of its own) means the very next `constructPath` defines the clip
 * shape rather than something that gets painted.
 * This generalizes better than hand-rolling rectangle-only math: it works
 * for ANY path shape, not just axis-aligned rectangles, since we just take
 * PDF.js's own bbox rather than reconstructing it from path points.
 */
/** Grow a bbox outward by `pad` on every side (used for the tolerance check,
 * never for the stored/reported bbox itself — only at safe-zone comparison
 * time). */
function padBBox(b, pad) {
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

/** Approximate uniform scale factor of a 2D affine matrix (determinant-based
 * square root) — used to convert a user-space line width into page-space
 * padding. Approximate for non-uniform scale/skew, same spirit as the text
 * ascent/descent ratios above: good enough to decide safe/unsafe. */
function approxScale(m) {
  const [a, b, c, d] = m;
  return Math.sqrt(Math.abs(a * d - b * c));
}

// Per Gemini's third review point: a STROKED path's visible extent extends
// half the line width beyond its geometric path on every side. constructPath's
// own minMax bbox (confirmed by testing) is the bare path geometry only — it
// does NOT account for stroke width — so we pad it ourselves when the paint
// op (constructPath's args[0], confirmed by testing to equal the real OPS
// code of fill/stroke/clip the path belongs to) is one of the stroke variants.
function analyzeOperatorList(fnArray, argsArray, OPS) {
  const results = [];

  const strokePaintCodes = new Set([
    OPS.stroke,
    OPS.closeStroke,
    OPS.fillStroke,
    OPS.eoFillStroke,
    OPS.closeFillStroke,
    OPS.closeEOFillStroke,
  ]);

  let ctm = IDENTITY;
  let clipBBox = null; // null = unclipped (whole page)
  let clipPending = false;
  let lineWidth = 1; // PDF default line width is 1 user-space unit
  const stack = [];

  // Text state (per Gemini review point 1: showText/showSpacedText must
  // also go through the same clip-intersection path as vector fills).
  let textMatrix = IDENTITY;
  let fontSize = 0;

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i];

    switch (op) {
      case OPS.save:
        stack.push({ ctm, clipBBox, lineWidth });
        break;
      case OPS.restore: {
        const prev = stack.pop();
        if (prev) {
          ctm = prev.ctm;
          clipBBox = prev.clipBBox;
          lineWidth = prev.lineWidth;
        }
        break;
      }

      // --- Form XObject (found while doing the Margin/Color architecture
      // inventory, 2026-10-04 -- confirmed by building a real fixture, not
      // assumed): pdf.js's getOperatorList() DOES inline a Form XObject's
      // own content directly into the page's op list (no separate
      // recursion needed on our side) -- but it brackets that content
      // with paintFormXObjectBegin/paintFormXObjectEnd rather than
      // emitting it as plain save/cm/clip/.../restore. Without handling
      // these two ops, a Form's own Matrix is silently never applied to
      // the CTM, and -- more importantly -- its content is never clipped
      // to its own /BBox (per spec, every Form XObject implicitly clips
      // its content to its declared BBox, independent of any `clip`
      // operator inside it; pdf.js's raw op list does NOT expose that
      // clip as an operator, it's applied internally only at render
      // time). Confirmed concretely: a form with BBox [0,0,50,50]
      // containing a rect from (-20,-20) to (80,80), placed via an outer
      // `cm` translate+scale(2x), previously reported the UNCLIPPED
      // extent -- ignoring the form's own BBox entirely. Treated exactly
      // like save/restore (a Form establishes its own isolated graphics-
      // state scope per spec), plus applying the form's Matrix and
      // intersecting the clip with its BBox, both already transformed by
      // the resulting CTM.
      case OPS.paintFormXObjectBegin: {
        stack.push({ ctm, clipBBox, lineWidth });
        const [matrixArg, bboxArg] = args;
        if (matrixArg) {
          const m = [matrixArg[0], matrixArg[1], matrixArg[2], matrixArg[3], matrixArg[4], matrixArg[5]];
          ctm = matMul(ctm, m);
        }
        if (bboxArg) {
          const formBBoxPt = transformBBoxMinMax(
            { minX: bboxArg[0], minY: bboxArg[1], maxX: bboxArg[2], maxY: bboxArg[3] },
            ctm
          );
          clipBBox = intersectBBox(clipBBox, formBBoxPt);
        }
        break;
      }
      case OPS.paintFormXObjectEnd: {
        const prev = stack.pop();
        if (prev) {
          ctm = prev.ctm;
          clipBBox = prev.clipBBox;
          lineWidth = prev.lineWidth;
        }
        break;
      }
      case OPS.setLineWidth:
        lineWidth = args[0];
        break;
      case OPS.transform: {
        const [a, b, c, d, e, f] = args;
        ctm = matMul(ctm, [a, b, c, d, e, f]);
        break;
      }
      case OPS.clip:
      case OPS.eoClip:
        clipPending = true;
        break;
      case OPS.constructPath: {
        const paintCode = args[0]; // the real OPS code of the fill/stroke/clip this path belongs to
        const minMax = args[2]; // {0:minX,1:minY,2:maxX,3:maxY} (typed-array-like)
        if (!minMax) break;
        const rectSpace = { minX: minMax[0], minY: minMax[1], maxX: minMax[2], maxY: minMax[3] };
        let transformed = transformBBoxMinMax(rectSpace, ctm);
        if (strokePaintCodes.has(paintCode)) {
          // Visible extent reaches half the line width past the bare path
          // geometry on every side (Gemini review point 3).
          const strokePad = (lineWidth / 2) * approxScale(ctm);
          transformed = padBBox(transformed, strokePad);
        }
        if (clipPending) {
          clipBBox = intersectBBox(clipBBox, transformed);
          clipPending = false;
        } else {
          const visibleBBoxPt = intersectBBox(clipBBox, transformed) || transformed;
          results.push({ type: 'path', rawBBoxPt: transformed, visibleBBoxPt, stroked: strokePaintCodes.has(paintCode) });
        }
        break;
      }

      // --- Images / Form XObjects: painted as the unit square [0,1]x[0,1]
      // positioned entirely by the accumulated CTM (no bbox of their own
      // in the operator list args — unlike constructPath). ---
      case OPS.paintImageXObject:
      case OPS.paintXObject:
      case OPS.paintInlineImageXObject: {
        const unitSquare = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
        const transformed = transformBBoxMinMax(unitSquare, ctm);
        const visibleBBoxPt = intersectBBox(clipBBox, transformed) || transformed;
        results.push({ type: 'image', rawBBoxPt: transformed, visibleBBoxPt });
        break;
      }

      // --- Text: no bbox of its own either — approximated from the text
      // matrix, font size, and summed glyph advance widths. ---
      case OPS.setFont:
        fontSize = args[1];
        break;
      case OPS.setTextMatrix: {
        const m = args[0];
        textMatrix = [m[0], m[1], m[2], m[3], m[4], m[5]];
        break;
      }
      case OPS.showText:
      case OPS.showSpacedText: {
        const glyphs = args[0] || [];
        let advance = 0;
        for (const g of glyphs) {
          if (typeof g === 'number') continue; // TJ kerning adjustment entry
          advance += ((g.width || 0) / 1000) * fontSize;
        }
        if (advance > 0 && fontSize > 0) {
          const textSpaceBBox = {
            minX: 0,
            minY: -APPROX_DESCENT_RATIO * fontSize,
            maxX: advance,
            maxY: APPROX_ASCENT_RATIO * fontSize,
          };
          const renderMatrix = matMul(ctm, textMatrix);
          const transformed = transformBBoxMinMax(textSpaceBBox, renderMatrix);
          const visibleBBoxPt = intersectBBox(clipBBox, transformed) || transformed;
          results.push({ type: 'text', rawBBoxPt: transformed, visibleBBoxPt, approximate: true });
          // Advance the text matrix horizontally so a following showText
          // in the same block starts from the right place.
          textMatrix = matMul(textMatrix, [1, 0, 0, 1, advance, 0]);
        }
        break;
      }
      default:
        break;
    }
  }

  return results;
}

/**
 * Compare a detected object's visible bbox against a safe-zone bbox
 * (e.g. the LEM boundary), applying Gemini's export-noise tolerance.
 * Returns true if the object is safely inside the zone.
 */
function isWithinSafeZone(visibleBBoxPt, safeZoneBBoxPt) {
  const padded = padBBox(safeZoneBBoxPt, TOLERANCE_PT);
  return (
    visibleBBoxPt.minX >= padded.minX &&
    visibleBBoxPt.minY >= padded.minY &&
    visibleBBoxPt.maxX <= padded.maxX &&
    visibleBBoxPt.maxY <= padded.maxY
  );
}

// Shared with lib/autofix.js's planAutofix() via lib/marginPolicy.js
// (extracted 2026-10-05, after the detection/autofix reconciliation pass
// found the two files disagreeing at the exact threshold boundary due to
// float noise -- see marginPolicy.js's header for the full story). This
// is a plain require, not a circular one: marginPolicy.js has no
// dependency on margin.js or autofix.js.
const { LEM_AUTOFIX_THRESHOLD_PT, exceedsAutofixThreshold } = require('./marginPolicy');

const SIDE_DESCRIPTORS = [
  { side: 'left', dir: -1, edge: 'minX' },
  { side: 'right', dir: 1, edge: 'maxX' },
  { side: 'bottom', dir: -1, edge: 'minY' },
  { side: 'top', dir: 1, edge: 'maxY' },
];

/**
 * Signed overshoot of `value` past `boundary`, outward, given the side's
 * direction convention: dir -1 is a min-side (left/bottom), where outward
 * is negative, so overshoot = boundary - value; dir +1 is a max-side
 * (right/top), where outward is positive, so overshoot = value - boundary.
 * Positive return = past the boundary, outward; zero/negative = still
 * inside it (or exactly on it).
 */
function overshoot(value, boundary, dir) {
  return dir < 0 ? boundary - value : value - boundary;
}

/**
 * Classify one detected object's VISIBLE bbox against the page's
 * trim/LEM/bleed zones, per side, into zero or more structured violation
 * entries. This is KDPSafe's own detection vocabulary (requested
 * 2026-10-05 for the Margin/Bleed/LEM detection-only stage) -- built
 * directly on top of concepts that already existed in this codebase
 * (isWithinSafeZone's TOLERANCE_PT noise allowance; autofix.js's
 * touchedPageEdges/checkBleedCoverage vs. computeShiftToFit split and its
 * THRESHOLD_IN/THRESHOLD_PT autofix-eligibility cutoff) rather than
 * inventing parallel ideas -- this function reframes those as a pure
 * detection/diagnostic result, with no autofix decision or PDF mutation
 * attached. Autofix (lib/autofix.js) is untouched by this change.
 *
 * Per-side rule:
 *   - If the object's visible bbox extends past the TRIM edge on this
 *     side (beyond TOLERANCE_PT), it's a bleed candidate: with a
 *     bleedBoxPt given, reaching/exceeding the bleed edge is safe
 *     (intentional bleed); falling short is a 'BLEED' violation, whose
 *     amountPt is the gap between the object's edge and the bleed edge.
 *     Without a bleedBoxPt this side can't be evaluated and is skipped --
 *     a documented limitation, not a silent false negative: callers
 *     should always pass bleedBoxPt for pages that support bleed.
 *   - Otherwise, if it extends past the LEM boundary (also beyond
 *     TOLERANCE_PT) while still inside trim, that's a 'LEM' violation,
 *     amountPt = how far past the LEM boundary.
 *   - Otherwise this side is safe (no entry produced for it).
 *
 * Severity:
 *   - 'BLEED' is always 'error' -- autofix.js's checkBleedCoverage never
 *     offers an automatic fix for a bleed gap either (shifting one edge
 *     risks opening a gap on the opposite, already-correct edge).
 *   - 'LEM' on a 'text' object is always 'error' -- text is never
 *     auto-corrected, per autofix.js, regardless of violation size.
 *   - 'LEM' on a non-text object is 'warning' when amountPt is within the
 *     shift-autofix threshold (amountPt <= LEM_AUTOFIX_THRESHOLD_PT,
 *     exactly mirroring autofix.js's own `magnitude > THRESHOLD_PT` cutoff
 *     -- equal-to-threshold is still autofix-eligible there, so it's still
 *     'warning' here), 'error' strictly above it.
 *
 * Does NOT touch the clipping engine's AABB approximation (still the
 * standing, deliberate limitation documented at the top of this file) and
 * performs no PDF rewrite -- detection/diagnostics only.
 *
 * @param {{type: 'text'|'image'|'path', rawBBoxPt: object, visibleBBoxPt: object}} obj
 *   one entry from analyzeOperatorList()/analyzePageObjects()'s results
 * @param {{trimBoxPt: object, safeZoneBBoxPt: object, bleedBoxPt?: object}} zones
 *   all in the same {minX,minY,maxX,maxY} page-point form as rawBBoxPt/visibleBBoxPt
 * @param {{top: boolean, bottom: boolean, left: boolean, right: boolean}} [allowedSides]
 *   OPTIONAL (added 2026-10-05, CHECKPOINT 3, for lib/orchestrator.js's
 *   safety gate -- see resolveAllowedSides() there). When omitted, every
 *   side is evaluated exactly as before this parameter existed -- this is
 *   a purely additive, backward-compatible change; no existing call site
 *   (every pre-2026-10-05 test) passes a third argument, so none of them
 *   can observe any behavior difference. When provided, a side whose flag
 *   is not strictly `true` is skipped BEFORE any arithmetic touches
 *   trimBoxPt[edge]/safeZoneBBoxPt[edge]/bleedBoxPt[edge] for that side --
 *   this is what actually prevents the null->0 coercion bug found in the
 *   CHECKPOINT 2 audit (overshoot(value, null, dir) silently computing
 *   `value - 0`/`0 - value` instead of refusing to answer). Callers are
 *   responsible for computing a geometry-aware `allowedSides` (never hand
 *   this function a guessed value); this function itself does not guess.
 * @returns {Array<{
 *   type: string, violation: 'LEM'|'BLEED', side: 'left'|'right'|'bottom'|'top',
 *   amountPt: number, rawBBoxPt: object, visibleBBoxPt: object,
 *   severity: 'warning'|'error',
 * }>}
 */
function classifyViolations(obj, zones, allowedSides) {
  const { trimBoxPt, safeZoneBBoxPt, bleedBoxPt } = zones;
  const bbox = obj.visibleBBoxPt;
  const violations = [];

  for (const { side, dir, edge } of SIDE_DESCRIPTORS) {
    if (allowedSides && allowedSides[side] !== true) continue;
    const value = bbox[edge];
    const trimOvershoot = overshoot(value, trimBoxPt[edge], dir);

    if (trimOvershoot > TOLERANCE_PT) {
      if (!bleedBoxPt) continue; // can't evaluate bleed coverage -- skip (documented limitation)
      const bleedOvershoot = overshoot(value, bleedBoxPt[edge], dir);
      if (bleedOvershoot >= -TOLERANCE_PT) continue; // reaches/exceeds the bleed edge -- intentional bleed, safe
      violations.push({
        type: obj.type,
        violation: 'BLEED',
        side,
        amountPt: -bleedOvershoot,
        rawBBoxPt: obj.rawBBoxPt,
        visibleBBoxPt: obj.visibleBBoxPt,
        severity: 'error',
      });
      continue;
    }

    const lemOvershoot = overshoot(value, safeZoneBBoxPt[edge], dir);
    if (lemOvershoot > TOLERANCE_PT) {
      // exceedsAutofixThreshold() (lib/marginPolicy.js) carries its own
      // float-noise epsilon on this comparison -- see that module's
      // header for why (distinct from TOLERANCE_PT above, which governs
      // whether a violation exists at all, not where the severity line
      // sits within one).
      const severity =
        obj.type === 'text' || exceedsAutofixThreshold(lemOvershoot) ? 'error' : 'warning';
      violations.push({
        type: obj.type,
        violation: 'LEM',
        side,
        amountPt: lemOvershoot,
        rawBBoxPt: obj.rawBBoxPt,
        visibleBBoxPt: obj.visibleBBoxPt,
        severity,
      });
    }
  }

  return violations;
}

/**
 * @param {Uint8Array} pdfBytes
 * @param {number} pageIndex 0-based
 */
async function analyzePageObjects(pdfBytes, pageIndex = 0) {
  const pdfjsLib = await loadPdfjs();
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes, isEvalSupported: false });
  const doc = await loadingTask.promise;
  const page = await doc.getPage(pageIndex + 1); // pdf.js pages are 1-based
  const opList = await page.getOperatorList();
  return analyzeOperatorList(opList.fnArray, opList.argsArray, pdfjsLib.OPS);
}

module.exports = {
  analyzePageObjects,
  analyzeOperatorList,
  matMul,
  transformRectBBox,
  intersectBBox,
  isWithinSafeZone,
  classifyViolations,
  LEM_AUTOFIX_THRESHOLD_PT,
  TOLERANCE_PT,
};
