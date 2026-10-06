'use strict';

/**
 * Smart Fix Phase 2 — the writer. This is the ONE place that actually
 * mutates PDF bytes for Smart Fix; everything upstream (geometryProblems,
 * strategies/*, repairPlanner) is still read-only planning. Two
 * independently-proven primitives, both empirically verified by hand
 * before being wired in here (see conversation record / commit message):
 *
 *   1. Content-stream-wide transform: `page.node.Contents()` always
 *      normalizes to a PDFArray of stream refs. We register two NEW raw
 *      streams — a `q <sx> 0 0 <sy> <dx> <dy> cm` prepend and a bare `Q`
 *      append — and splice them around the EXISTING content refs. This
 *      never touches a single byte of the original content stream(s), so
 *      it is correct for arbitrary content complexity (text, vectors,
 *      images, nested Form XObjects — all of it lives inside the now-
 *      wrapped `q ... cm ... Q` block and is transformed by the CTM like
 *      everything else PDF already knows how to transform).
 *   2. Annotation /Rect rewrite by the SAME (sx, sy, dx, dy) — see
 *      annotations.js's header for why this is sufficient without
 *      touching /AP's own Matrix/BBox.
 *
 * BOX_NORMALIZATION writes ONLY /TrimBox and/or /BleedBox — no content
 * transform, no annotation rewrite (nothing moved).
 * PADDING / PROPORTIONAL_SCALE / SCALE_PLUS_PADDING all reduce to the
 * exact same content-transform + annotation-transform + box-rewrite
 * sequence, differing only in their (sx, sy, dx, dy) numbers — PADDING is
 * simply the sx=sy=1 case. One writer function handles all three.
 */

const { PDFDocument, PDFName, PDFRawStream } = require('pdf-lib');

/**
 * Where to place /TrimBox (and, when requested, /BleedBox) within a page
 * whose MediaBox is targetWidthPt x targetHeightPt.
 *
 * Vertical placement is EXACT, not a compromise: KDP's bleed formula is
 * symmetric top/bottom (both 0.125in — see lib/zones.js's BLEED_TOP_IN /
 * BLEED_BOTTOM_IN), so centering the trim box vertically within the
 * bleed-inclusive page is the only placement consistent with that
 * symmetric formula.
 *
 * Horizontal placement is a KNOWN, DOCUMENTED COMPROMISE: KDP's bleed/
 * margin rules are asymmetric inside (gutter) vs. outside, but — exactly
 * as lib/zones.js's own module header documents at length — nothing in
 * this codebase carries page-parity/binding-edge information to resolve
 * which physical side is the gutter. Rather than guess, this writer
 * horizontally CENTERS the trim box within the page. This is not provably
 * wrong (bleed's outer-edge amount is the same 0.125in regardless of
 * which side is "outer"), but it does not correctly express KDP's actual
 * asymmetric gutter requirement either. This mirrors the project's
 * existing, explicit practice of surfacing such gaps openly rather than
 * silently guessing a side.
 */
function computeBoxPlacement(pageWidthPt, pageHeightPt, trimWidthPt, trimHeightPt, writeBleedBox) {
  const trimX = (pageWidthPt - trimWidthPt) / 2;
  const trimY = (pageHeightPt - trimHeightPt) / 2;
  return {
    trimBox: { x: trimX, y: trimY, width: trimWidthPt, height: trimHeightPt },
    bleedBox: writeBleedBox ? { x: 0, y: 0, width: pageWidthPt, height: pageHeightPt } : null,
  };
}

/**
 * BOX_NORMALIZATION: box-dict-only, zero content mutation.
 */
function applyBoxNormalization(page, strategy) {
  const { writeTrimBox, writeBleedBox, targetWidthPt, targetHeightPt } = strategy.params;
  if (!writeTrimBox && !writeBleedBox) return;

  // Phase 1's BOX_NORMALIZATION only ever fires when sizeRelation==='EXACT'
  // — i.e. MediaBox already equals targetWidthPt/targetHeightPt (trim, or
  // trim+bleed). The trim box's own dimensions are the user's trim size,
  // not the (possibly bleed-inclusive) target — callers pass trimWidthPt/
  // trimHeightPt explicitly via strategy.params for exactly this reason.
  const trimWidthPt = strategy.params.trimWidthPt ?? targetWidthPt;
  const trimHeightPt = strategy.params.trimHeightPt ?? targetHeightPt;
  const placement = computeBoxPlacement(targetWidthPt, targetHeightPt, trimWidthPt, trimHeightPt, writeBleedBox);

  if (writeTrimBox) {
    page.setTrimBox(placement.trimBox.x, placement.trimBox.y, placement.trimBox.width, placement.trimBox.height);
  }
  if (writeBleedBox && placement.bleedBox) {
    page.setBleedBox(placement.bleedBox.x, placement.bleedBox.y, placement.bleedBox.width, placement.bleedBox.height);
  }
}

/**
 * The shared content-stream-wide transform writer. Wraps the page's
 * EXISTING /Contents (whatever they are) in a `q <sx> 0 0 <sy> <dx> <dy>
 * cm ... Q` block, then rewrites /MediaBox and /TrimBox(/BleedBox) to the
 * new target size, then rewrites every safe annotation's /Rect by the same
 * transform. Used by PADDING (sx=sy=1) and PROPORTIONAL_SCALE/
 * SCALE_PLUS_PADDING (sx,sy from the computed scale factor) alike.
 *
 * @param {import('pdf-lib').PDFDocument} doc
 * @param {import('pdf-lib').PDFPage} page
 * @param {{sx:number, sy:number, dx:number, dy:number}} transform
 * @param {{targetWidthPt:number, targetHeightPt:number, trimWidthPt:number, trimHeightPt:number, writeBleedBox:boolean}} boxParams
 */
function applyContentTransform(doc, page, transform, boxParams) {
  const { sx, sy, dx, dy } = transform;
  const ctx = doc.context;

  const existingContents = page.node.Contents();
  const existingRefs = existingContents && typeof existingContents.asArray === 'function'
    ? existingContents.asArray()
    : existingContents
      ? [page.node.get(PDFName.of('Contents'))]
      : [];

  // Plain ASCII PDF operators only (numbers + "q cm Q"), so TextEncoder's
  // UTF-8 output is byte-identical to Latin-1/ASCII here. Using
  // TextEncoder instead of Node's global `Buffer` keeps this module
  // runnable unmodified in a browser bundle (Vite/Webpack do not polyfill
  // `Buffer` by default) — a pure encoding-mechanics swap, not a change to
  // any safety/geometry logic. `PDFRawStream.of()` accepts any
  // Uint8Array, so no other change is needed.
  const prependBytes = new TextEncoder().encode(`q ${sx} 0 0 ${sy} ${dx} ${dy} cm\n`);
  const appendBytes = new TextEncoder().encode('Q\n');

  const prependStream = PDFRawStream.of(ctx.obj({ Length: prependBytes.length }), prependBytes);
  const appendStream = PDFRawStream.of(ctx.obj({ Length: appendBytes.length }), appendBytes);
  const prependRef = ctx.register(prependStream);
  const appendRef = ctx.register(appendStream);

  page.node.set(PDFName.of('Contents'), ctx.obj([prependRef, ...existingRefs, appendRef]));

  // New page geometry: MediaBox always becomes exactly the target size
  // (by construction, every Phase 2 scale/pad strategy is designed to land
  // exactly there — see strategies/proportionalScale.js and
  // scalePlusPadding.js headers for the proof).
  page.setMediaBox(0, 0, boxParams.targetWidthPt, boxParams.targetHeightPt);

  const placement = computeBoxPlacement(
    boxParams.targetWidthPt,
    boxParams.targetHeightPt,
    boxParams.trimWidthPt,
    boxParams.trimHeightPt,
    boxParams.writeBleedBox
  );
  page.setTrimBox(placement.trimBox.x, placement.trimBox.y, placement.trimBox.width, placement.trimBox.height);
  if (boxParams.writeBleedBox && placement.bleedBox) {
    page.setBleedBox(placement.bleedBox.x, placement.bleedBox.y, placement.bleedBox.width, placement.bleedBox.height);
  }

  const { transformPageAnnotations } = require('./annotations');
  transformPageAnnotations(doc, page, { sx, sy, dx, dy });
}

/**
 * Builds the {sx,sy,dx,dy} transform + box params for ANY of the three
 * content-moving strategy types, from its own `strategy.params` (each
 * strategy module's buildTransform() already computes the strategy-
 * specific numbers; this just normalizes them into the one shape
 * applyContentTransform() needs).
 */
function transformFromStrategy(strategy, pageAnalysis) {
  const trimOnly = pageAnalysis.targetTrimOnlyPt;
  const writeBleedBox = !!(pageAnalysis.target && trimOnly && (pageAnalysis.target.widthPt > trimOnly.widthPt + 0.01 || pageAnalysis.target.heightPt > trimOnly.heightPt + 0.01));

  if (strategy.type === 'PADDING') {
    return {
      transform: { sx: 1, sy: 1, dx: strategy.params.padWidthTotalPt / 2, dy: strategy.params.padHeightTotalPt / 2 },
      boxParams: {
        targetWidthPt: strategy.params.targetWidthPt,
        targetHeightPt: strategy.params.targetHeightPt,
        trimWidthPt: trimOnly ? trimOnly.widthPt : strategy.params.targetWidthPt,
        trimHeightPt: trimOnly ? trimOnly.heightPt : strategy.params.targetHeightPt,
        writeBleedBox,
      },
    };
  }

  // PROPORTIONAL_SCALE / SCALE_PLUS_PADDING share the same params shape.
  return {
    transform: { sx: strategy.params.scaleFactor, sy: strategy.params.scaleFactor, dx: strategy.params.dx, dy: strategy.params.dy },
    boxParams: {
      targetWidthPt: strategy.params.targetWidthPt,
      targetHeightPt: strategy.params.targetHeightPt,
      trimWidthPt: trimOnly ? trimOnly.widthPt : strategy.params.targetWidthPt,
      trimHeightPt: trimOnly ? trimOnly.heightPt : strategy.params.targetHeightPt,
      writeBleedBox,
    },
  };
}

/**
 * Applies ONE page's chosen strategy to an already-loaded pdf-lib
 * PDFDocument, in place.
 */
function applyStrategyToPage(doc, page, strategy, pageAnalysis) {
  if (strategy.type === 'BOX_NORMALIZATION') {
    applyBoxNormalization(page, {
      params: {
        ...strategy.params,
        trimWidthPt: pageAnalysis.targetTrimOnlyPt ? pageAnalysis.targetTrimOnlyPt.widthPt : strategy.params.targetWidthPt,
        trimHeightPt: pageAnalysis.targetTrimOnlyPt ? pageAnalysis.targetTrimOnlyPt.heightPt : strategy.params.targetHeightPt,
      },
    });
    return;
  }

  const { transform, boxParams } = transformFromStrategy(strategy, pageAnalysis);
  applyContentTransform(doc, page, transform, boxParams);
}

/**
 * Applies a whole document's worth of plans (as produced by
 * repairPlanner.js / smartFixEngine.planRepair()) to pdfBytes, writing
 * ONLY the pages whose plan is eligible per `opts`.
 *
 * Eligibility (never applies MANUAL_REVIEW/DO_NOT_TOUCH/no-strategy
 * pages, regardless of `opts`):
 *   - chosenStrategy.risk.level === 'SAFE_AUTOFIX' -> always applied.
 *   - chosenStrategy.risk.level === 'USER_CONFIRMATION' -> applied only
 *     when pageIndex is listed in opts.confirmedPageIndexes.
 *
 * @returns {Promise<{ outputBytes: Uint8Array, appliedPageIndexes: number[], skipped: Array<{pageIndex:number, reason:string}> }>}
 */
async function applyPlanToDocument(pdfBytes, plans, pageAnalyses, opts = {}) {
  const confirmed = new Set(opts.confirmedPageIndexes || []);
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();

  const appliedPageIndexes = [];
  const skipped = [];

  for (const plan of plans) {
    const pageAnalysis = pageAnalyses.find((p) => p.pageIndex === plan.pageIndex);
    if (!plan.chosenStrategy) {
      if (plan.problem) skipped.push({ pageIndex: plan.pageIndex, reason: 'MANUAL_REVIEW' });
      continue;
    }
    const level = plan.chosenStrategy.risk.level;
    const eligible = level === 'SAFE_AUTOFIX' || (level === 'USER_CONFIRMATION' && confirmed.has(plan.pageIndex));
    if (!eligible) {
      skipped.push({ pageIndex: plan.pageIndex, reason: `NOT_CONFIRMED_${level}` });
      continue;
    }

    applyStrategyToPage(doc, pages[plan.pageIndex], plan.chosenStrategy, pageAnalysis);
    appliedPageIndexes.push(plan.pageIndex);
  }

  const outputBytes = await doc.save();
  return { outputBytes, appliedPageIndexes, skipped };
}

module.exports = {
  computeBoxPlacement,
  applyBoxNormalization,
  applyContentTransform,
  transformFromStrategy,
  applyStrategyToPage,
  applyPlanToDocument,
};
