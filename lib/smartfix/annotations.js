'use strict';

/**
 * Smart Fix Phase 2 — annotation read/write. Pure pdf-lib, no pdfjs.
 *
 * Key insight (PDF spec §12.5.5): an annotation's /AP appearance stream is
 * defined relative to its own /BBox and auto-fits into whatever /Rect the
 * annotation dictionary currently says (the viewer maps /BBox -> /Rect via
 * the Matrix entry in /AP's form-dict at render time). That means: for a
 * UNIFORM transform (scale + translate, never rotation/skew — exactly what
 * every Phase 2 content-stream strategy produces), rewriting ONLY /Rect by
 * the same (sx, sy, dx, dy) applied to the page content keeps the
 * annotation's on-page appearance correctly aligned with the content around
 * it, with no need to touch /AP's own /Matrix or /BBox at all. This is what
 * keeps Phase 2's annotation-rewrite scope small and provably correct,
 * rather than requiring a general appearance-stream rewriter.
 *
 * Safety boundary: an annotation whose geometry is NOT a simple rectangle
 * (/QuadPoints — multi-quad text markup; /Vertices / /InkList — polyline/
 * freehand ink) cannot be safely re-expressed by transforming /Rect alone —
 * those arrays carry their own coordinates, independent of /Rect, and
 * transforming /Rect without also transforming them would leave the
 * annotation's actual marked geometry pointing at the wrong place. Per
 * "safety over coverage", a page carrying ANY such annotation is reported
 * as unsafe-to-transform in its entirety (repairPlanner.js's central
 * override then forces MANUAL_REVIEW for every content-moving strategy on
 * that page — BOX_NORMALIZATION, which never moves content, is unaffected).
 */

const { PDFName } = require('pdf-lib');

const COMPLEX_GEOMETRY_KEYS = ['QuadPoints', 'Vertices', 'InkList'];

/**
 * @param {import('pdf-lib').PDFDocument} doc
 * @param {import('pdf-lib').PDFPage} page
 * @returns {{ count: number, unsafeToTransform: boolean, unsafeReasons: string[], entries: Array<{ref: object, subtype: string|null, rectPt: {minX:number,minY:number,maxX:number,maxY:number}|null, hasComplexGeometry: boolean}> }}
 */
function readPageAnnotationSafety(doc, page) {
  const annotsObj = page.node.Annots ? page.node.Annots() : undefined;
  if (!annotsObj || typeof annotsObj.asArray !== 'function') {
    return { count: 0, unsafeToTransform: false, unsafeReasons: [], entries: [] };
  }

  const entries = [];
  const unsafeReasons = [];
  let unsafeToTransform = false;

  for (const ref of annotsObj.asArray()) {
    const dict = doc.context.lookup(ref);
    if (!dict || typeof dict.lookup !== 'function') continue;

    const subtypeObj = dict.lookup(PDFName.of('Subtype'));
    const subtype = subtypeObj && typeof subtypeObj.asString === 'function' ? subtypeObj.asString() : null;

    const rectObj = dict.lookup(PDFName.of('Rect'));
    let rectPt = null;
    if (rectObj && typeof rectObj.asArray === 'function') {
      const nums = rectObj.asArray().map((n) => (typeof n.asNumber === 'function' ? n.asNumber() : NaN));
      if (nums.length === 4 && nums.every((n) => Number.isFinite(n))) {
        rectPt = {
          minX: Math.min(nums[0], nums[2]),
          minY: Math.min(nums[1], nums[3]),
          maxX: Math.max(nums[0], nums[2]),
          maxY: Math.max(nums[1], nums[3]),
        };
      }
    }

    const hasComplexGeometry = COMPLEX_GEOMETRY_KEYS.some((key) => dict.lookup(PDFName.of(key)) !== undefined);
    if (hasComplexGeometry) {
      unsafeToTransform = true;
      unsafeReasons.push(
        `Анотація (${subtype || 'невідомого типу'}) має геометрію поза простим /Rect (${COMPLEX_GEOMETRY_KEYS.filter((k) => dict.lookup(PDFName.of(k)) !== undefined).join(', ')}) — безпечна трансформація лише /Rect недостатня для цієї анотації.`
      );
    }
    if (rectObj && !rectPt) {
      // /Rect is present but malformed/unreadable — fail safe rather than
      // silently skipping it.
      unsafeToTransform = true;
      unsafeReasons.push(`Анотація (${subtype || 'невідомого типу'}) має /Rect, який не вдалось прочитати як 4 числа.`);
    }

    entries.push({ ref, dict, subtype, rectPt, hasComplexGeometry });
  }

  return { count: entries.length, unsafeToTransform, unsafeReasons, entries };
}

/**
 * Rewrites every safe (simple-/Rect) annotation's /Rect by the same
 * uniform (sx, sy, dx, dy) applied to the page content. Must only ever be
 * called on a page whose readPageAnnotationSafety().unsafeToTransform is
 * false — callers (repairWriter.js) are responsible for checking that
 * first; this function does not re-check it, to keep it a pure, dumb
 * writer with a single responsibility.
 *
 * @param {import('pdf-lib').PDFDocument} doc
 * @param {import('pdf-lib').PDFPage} page
 * @param {{sx:number, sy:number, dx:number, dy:number}} transform
 */
function transformPageAnnotations(doc, page, transform) {
  const { sx, sy, dx, dy } = transform;
  const safety = readPageAnnotationSafety(doc, page);

  for (const entry of safety.entries) {
    if (!entry.rectPt) continue;
    const newRect = [
      entry.rectPt.minX * sx + dx,
      entry.rectPt.minY * sy + dy,
      entry.rectPt.maxX * sx + dx,
      entry.rectPt.maxY * sy + dy,
    ];
    entry.dict.set(PDFName.of('Rect'), doc.context.obj(newRect));
  }

  return { transformedCount: safety.entries.filter((e) => e.rectPt).length };
}

module.exports = { readPageAnnotationSafety, transformPageAnnotations };
