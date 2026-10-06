'use strict';

/**
 * Fixture builders for Smart Fix Phase 2 tests. Follows the same
 * convention as test/make-smartfix-fixtures.js (Phase 1).
 *
 * KEY DIFFERENCE FROM PHASE 1 FIXTURES: most of these build a document
 * with enough TOTAL pages (>=24) that lib/zones.js's KDP gutter-margin
 * table resolves (see that module's GUTTER_TABLE_IN — below 24 pages,
 * insidePt/outsidePt are permanently unresolved, which is a real, inherited
 * limitation of the frozen engine, not a Phase 2 bug — see its own module
 * header). Without this, EVERY dry-run in dryRun.js would report "not
 * clean" purely from HORIZONTAL_GEOMETRY_UNRESOLVED, regardless of whether
 * the transform itself is geometrically fine — masking the actual
 * genuinely-testable safety behavior (does a specific transform create a
 * real margin violation?) behind an unrelated, already-known limitation.
 * Each "book" fixture below is page 0 = the page under test, pages 1..N-1
 * = filler pages already exactly the target (6x9) size, so they are
 * compliant/no-op and don't themselves generate noise.
 */

const { PDFDocument, PDFName, PDFString, PDFHexString, rgb } = require('pdf-lib');

const PT_PER_IN = 72;
const FILLER_PAGE_COUNT = 29; // + 1 test page = 30, inside [24,150] -> insideIn=0.375

const TARGET_6X9_NO_BLEED = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false };
const TARGET_6X9_WITH_BLEED = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true };

/**
 * @param {object} opts
 * @param {number} opts.pageWidthIn / opts.pageHeightIn  page 0's own size
 * @param {number} [opts.rotationDeg]
 * @param {{xIn:number,yIn:number,widthIn:number,heightIn:number}} [opts.rectangleIn]
 *   a filled rectangle drawn on page 0, in page-space inches (bottom-left
 *   origin) — stands in for "real content" so analyzePageObjects() has
 *   something to measure against margins, pre- and post-transform.
 * @param {boolean} [opts.bleed]  filler pages' size follows this too
 * @param {{rect?: {xIn,yIn,widthIn,heightIn}, quadPoints?: boolean}} [opts.annotation]
 */
// 1x1 red pixel PNG — the smallest possible real embedded raster image,
// standing in for a "low-resolution image" fixture: any placement larger
// than a postage stamp makes its effective DPI drop far below any
// reasonable threshold.
const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAAl21bKAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function buildTestBook(opts) {
  const {
    pageWidthIn,
    pageHeightIn,
    rotationDeg = 0,
    rectangleIn = null,
    bleed = false,
    annotation = null,
    fillerCount = FILLER_PAGE_COUNT,
    lowResImageIn = null,
  } = opts;

  const doc = await PDFDocument.create();
  const testPage = doc.addPage([pageWidthIn * PT_PER_IN, pageHeightIn * PT_PER_IN]);

  if (rotationDeg !== 0) {
    testPage.setRotation({ angle: rotationDeg, type: 'degrees' });
  }
  if (rectangleIn) {
    testPage.drawRectangle({
      x: rectangleIn.xIn * PT_PER_IN,
      y: rectangleIn.yIn * PT_PER_IN,
      width: rectangleIn.widthIn * PT_PER_IN,
      height: rectangleIn.heightIn * PT_PER_IN,
      color: rgb(0, 0, 0),
    });
  }
  if (lowResImageIn) {
    const png = await doc.embedPng(Buffer.from(ONE_PX_PNG_BASE64, 'base64'));
    testPage.drawImage(png, {
      x: lowResImageIn.xIn * PT_PER_IN,
      y: lowResImageIn.yIn * PT_PER_IN,
      width: lowResImageIn.widthIn * PT_PER_IN,
      height: lowResImageIn.heightIn * PT_PER_IN,
    });
  }

  if (annotation) {
    const ctx = doc.context;
    const rect = annotation.rect || { xIn: 0.5, yIn: 0.5, widthIn: 1, heightIn: 0.3 };
    const rectPt = [
      rect.xIn * PT_PER_IN,
      rect.yIn * PT_PER_IN,
      (rect.xIn + rect.widthIn) * PT_PER_IN,
      (rect.yIn + rect.heightIn) * PT_PER_IN,
    ];
    const annotDictProps = {
      Type: 'Annot',
      Subtype: 'Link',
      Rect: ctx.obj(rectPt),
    };
    if (annotation.quadPoints) {
      // QuadPoints: 8 numbers (4 corner points) — presence alone is
      // enough to trip the "complex geometry" unsafe-to-transform check,
      // regardless of whether the values are geometrically meaningful.
      annotDictProps.QuadPoints = ctx.obj([
        rectPt[0], rectPt[3], rectPt[2], rectPt[3], rectPt[0], rectPt[1], rectPt[2], rectPt[1],
      ]);
      annotDictProps.Subtype = 'Highlight';
    }
    const annotDict = ctx.obj(annotDictProps);
    const annotRef = ctx.register(annotDict);
    testPage.node.set(PDFName.of('Annots'), ctx.obj([annotRef]));
  }

  const fillerWidthPt = bleed ? 6.125 * PT_PER_IN : 6 * PT_PER_IN;
  const fillerHeightPt = bleed ? 9.25 * PT_PER_IN : 9 * PT_PER_IN;
  for (let i = 0; i < fillerCount; i++) {
    doc.addPage([fillerWidthPt, fillerHeightPt]);
  }

  return doc.save();
}

/** Page 0 already exactly 6x9in, no boxes — BOX_NORMALIZATION / no-op case. */
function buildExactSizeBook() {
  return buildTestBook({ pageWidthIn: 6, pageHeightIn: 9 });
}

/**
 * Page 0 smaller than target by `deficitIn` on both axes, with a
 * rectangle drawn safely within what WILL be the post-pad safe zone
 * (so this is a genuinely clean padding case, not an artifact of empty
 * content).
 */
function buildTooSmallBook(deficitIn) {
  return buildTestBook({
    pageWidthIn: 6 - deficitIn,
    pageHeightIn: 9 - deficitIn,
    rectangleIn: { xIn: 1, yIn: 1, widthIn: (6 - deficitIn) - 2, heightIn: (9 - deficitIn) - 2 },
  });
}

/**
 * The user's explicit headline scenario: 8.5x11in -> 6x9in + bleed.
 * Content rectangle drawn comfortably inside the margins both before AND
 * after the scale-down (well inside the smaller of the two safe zones),
 * so this is the clean, should-succeed case.
 */
function build85x11ToTargetWithBleedBook() {
  return buildTestBook({
    pageWidthIn: 8.5,
    pageHeightIn: 11,
    rectangleIn: { xIn: 1.5, yIn: 1.5, widthIn: 5.5, heightIn: 8 },
    bleed: true,
  });
}

/**
 * A page whose aspect ratio ALREADY matches the target exactly (8x12 has
 * the same 2:3 ratio as 6x9) — pure PROPORTIONAL_SCALE, zero padding.
 * scaleFactor = 6/8 = 9/12 = 0.75.
 */
function buildAspectMatchedOversizedBook() {
  return buildTestBook({
    pageWidthIn: 8,
    pageHeightIn: 12,
    rectangleIn: { xIn: 1, yIn: 1, widthIn: 6, heightIn: 10 },
  });
}

/**
 * Aspect-MISMATCHED oversized page (8.5x11, no bleed target) — the
 * general SCALE_PLUS_PADDING case without bleed, content placed
 * comfortably inside margins both before and after scaling (clean,
 * should-succeed case; distinct from build85x11ToTargetWithBleedBook,
 * which targets WITH bleed).
 */
function buildTooLargeMismatchedBookForAudit() {
  return buildTestBook({
    pageWidthIn: 8.5,
    pageHeightIn: 11,
    rectangleIn: { xIn: 1.5, yIn: 1.5, widthIn: 5.5, heightIn: 8 },
  });
}

/**
 * Deliberately UNSAFE scale case: content rectangle sits EXACTLY at the
 * current page's own safe-margin boundary (compliant pre-scale, by
 * construction), on a page that otherwise matches target aspect ratio.
 * After uniform shrink, the ABSOLUTE margin around that rectangle shrinks
 * too — report 1's own named risk ("a page that had exactly the right
 * margin before scaling will have a smaller absolute margin after
 * scaling") — so the dry-run must catch this and force MANUAL_REVIEW.
 *
 * Target: 6x9in, no bleed -> safe margin = 0.25in on every side (outside)
 * for a 30-page book (insideIn=0.375in). Source page: 8x12in (same 2:3
 * aspect as target, scaleFactor=0.75). Pre-scale required margin on THIS
 * page, to be exactly compliant post-scale, would need to be
 * 0.25in/0.75=0.3333in; this fixture instead places content exactly
 * 0.25in from every edge of the SOURCE page (i.e. uses the TARGET's
 * margin amount, not the correctly-scaled one) — after a 0.75 shrink,
 * that becomes 0.1875in, well under the required 0.25in on every side.
 */
function buildScaleMarginViolationBook() {
  const pageWidthIn = 8;
  const pageHeightIn = 12;
  const marginIn = 0.25; // intentionally the TARGET's margin, not scaled
  return buildTestBook({
    pageWidthIn,
    pageHeightIn,
    rectangleIn: {
      xIn: marginIn,
      yIn: marginIn,
      widthIn: pageWidthIn - 2 * marginIn,
      heightIn: pageHeightIn - 2 * marginIn,
    },
  });
}

/** Rotated AND oversized — rotation must block every strategy, scale strategies included. */
function buildRotatedOversizedBook() {
  return buildTestBook({ pageWidthIn: 8.5, pageHeightIn: 11, rotationDeg: 90 });
}

/** Oversized page carrying one ordinary Link annotation with a simple /Rect only. */
function buildOversizedBookWithSafeAnnotation() {
  return buildTestBook({
    pageWidthIn: 8,
    pageHeightIn: 12,
    rectangleIn: { xIn: 1, yIn: 1, widthIn: 6, heightIn: 10 },
    annotation: { rect: { xIn: 1.5, yIn: 1.5, widthIn: 2, heightIn: 0.5 } },
  });
}

/** Oversized page carrying a Highlight annotation with /QuadPoints (complex geometry). */
function buildOversizedBookWithComplexAnnotation() {
  return buildTestBook({
    pageWidthIn: 8,
    pageHeightIn: 12,
    rectangleIn: { xIn: 1, yIn: 1, widthIn: 6, heightIn: 10 },
    annotation: { rect: { xIn: 1.5, yIn: 1.5, widthIn: 2, heightIn: 0.5 }, quadPoints: true },
  });
}

/**
 * Oversized page carrying a REAL embedded low-resolution raster image
 * (a 1x1px PNG stretched across most of the page) — tests the DPI guard
 * against a genuine image XObject, not a synthetic unit-test number.
 * Still only ever reached via a shrink (scaleFactor<1), so this is
 * expected to classify as safe (shrinking a low-res image never makes it
 * worse) — see dpiEstimator.js's header for why the guard's "unmeasured
 * image -> fails safe" branch is never reachable through this phase's
 * own registered strategies (which never enlarge).
 */
function buildOversizedBookWithLowResImage() {
  return buildTestBook({
    pageWidthIn: 8,
    pageHeightIn: 12,
    lowResImageIn: { xIn: 1, yIn: 1, widthIn: 6, heightIn: 10 },
  });
}

/** A too-small (padding) page carrying an ordinary Link annotation. */
function buildTooSmallBookWithSafeAnnotation(deficitIn) {
  return buildTestBook({
    pageWidthIn: 6 - deficitIn,
    pageHeightIn: 9 - deficitIn,
    rectangleIn: { xIn: 1, yIn: 1, widthIn: (6 - deficitIn) - 2, heightIn: (9 - deficitIn) - 2 },
    annotation: { rect: { xIn: 1.2, yIn: 1.2, widthIn: 1, heightIn: 0.3 } },
  });
}

/**
 * Interleaved mixed-page document: three DIFFERENT real scenarios in one
 * book (exact/no-op, too-small/padding, oversized-aspect-matched/scale),
 * not just two distinct pages plus uniform filler — closer to a genuine
 * manuscript where different pages came from different sources.
 */
async function buildInterleavedMixedBook() {
  const doc = await PDFDocument.create();

  const exactPage = doc.addPage([6 * PT_PER_IN, 9 * PT_PER_IN]);
  exactPage.drawRectangle({ x: 1 * PT_PER_IN, y: 1 * PT_PER_IN, width: 4 * PT_PER_IN, height: 7 * PT_PER_IN, color: rgb(0, 0, 0) });

  const tooSmallPage = doc.addPage([(6 - 0.3) * PT_PER_IN, (9 - 0.3) * PT_PER_IN]);
  tooSmallPage.drawRectangle({ x: 1 * PT_PER_IN, y: 1 * PT_PER_IN, width: ((6 - 0.3) - 2) * PT_PER_IN, height: ((9 - 0.3) - 2) * PT_PER_IN, color: rgb(0, 0, 0) });

  const oversizedPage = doc.addPage([8 * PT_PER_IN, 12 * PT_PER_IN]);
  oversizedPage.drawRectangle({ x: 1 * PT_PER_IN, y: 1 * PT_PER_IN, width: 6 * PT_PER_IN, height: 10 * PT_PER_IN, color: rgb(0, 0, 0) });

  for (let i = 0; i < FILLER_PAGE_COUNT; i++) {
    doc.addPage([6 * PT_PER_IN, 9 * PT_PER_IN]);
  }
  return doc.save();
}

/** Signed (/V present) PDF whose single real page is oversized. */
async function buildSignedOversizedPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([8 * PT_PER_IN, 12 * PT_PER_IN]);
  page.drawRectangle({ x: 1 * PT_PER_IN, y: 1 * PT_PER_IN, width: 6 * PT_PER_IN, height: 10 * PT_PER_IN, color: rgb(0, 0, 0) });
  const ctx = doc.context;

  const sigDict = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    Contents: PDFHexString.of('DEAD'),
    ByteRange: ctx.obj([0, 0, 0, 0]),
  });
  const sigRef = ctx.register(sigDict);

  const widgetDict = ctx.obj({
    FT: 'Sig',
    Type: 'Annot',
    Subtype: 'Widget',
    Rect: ctx.obj([0, 0, 10, 10]),
    V: sigRef,
    T: PDFString.of('Signature1'),
  });
  const widgetRef = ctx.register(widgetDict);

  const acroForm = ctx.obj({ Fields: ctx.obj([widgetRef]), SigFlags: 3 });
  doc.catalog.set(PDFName.of('AcroForm'), ctx.register(acroForm));
  page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));

  for (let i = 0; i < FILLER_PAGE_COUNT; i++) {
    doc.addPage([6 * PT_PER_IN, 9 * PT_PER_IN]);
  }
  return doc.save();
}

/** Mixed-page-size book: page 0 too-small (padding), page 1 oversized aspect-matched (scale). */
async function buildMixedStrategyBook() {
  const doc = await PDFDocument.create();
  // page 0: too small by 0.02in (SAFE_AUTOFIX padding)
  doc.addPage([(6 - 0.02) * PT_PER_IN, (9 - 0.02) * PT_PER_IN]);
  // page 1: 8x12in, aspect-matched oversized (PROPORTIONAL_SCALE)
  const page1 = doc.addPage([8 * PT_PER_IN, 12 * PT_PER_IN]);
  page1.drawRectangle({ x: 1 * PT_PER_IN, y: 1 * PT_PER_IN, width: 6 * PT_PER_IN, height: 10 * PT_PER_IN, color: rgb(0, 0, 0) });
  for (let i = 0; i < FILLER_PAGE_COUNT; i++) {
    doc.addPage([6 * PT_PER_IN, 9 * PT_PER_IN]);
  }
  return doc.save();
}

async function buildEncryptedOversizedPdf() {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const plain = await buildAspectMatchedOversizedBook();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdpsafe-smartfix2-'));
  const inPath = path.join(tmpDir, 'plain.pdf');
  const outPath = path.join(tmpDir, 'encrypted.pdf');
  fs.writeFileSync(inPath, plain);
  execFileSync('qpdf', ['--encrypt', 'owner-pw', 'user-pw', '256', '--', inPath, outPath]);
  const encrypted = fs.readFileSync(outPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return encrypted;
}

module.exports = {
  TARGET_6X9_NO_BLEED,
  TARGET_6X9_WITH_BLEED,
  buildTestBook,
  buildExactSizeBook,
  buildTooSmallBook,
  build85x11ToTargetWithBleedBook,
  buildAspectMatchedOversizedBook,
  buildTooLargeMismatchedBookForAudit,
  buildScaleMarginViolationBook,
  buildRotatedOversizedBook,
  buildOversizedBookWithSafeAnnotation,
  buildOversizedBookWithComplexAnnotation,
  buildOversizedBookWithLowResImage,
  buildTooSmallBookWithSafeAnnotation,
  buildInterleavedMixedBook,
  buildSignedOversizedPdf,
  buildMixedStrategyBook,
  buildEncryptedOversizedPdf,
};
