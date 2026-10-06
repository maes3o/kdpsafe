'use strict';

/**
 * Fixture builders for Smart Fix Phase 1 tests. Follows this repo's own
 * `make-*.js` convention (see make-pagebox-fixtures.js, make-mixed-
 * fixture.js) — plain async functions returning pdf-lib-produced bytes,
 * no committed binary fixtures.
 */

const { PDFDocument, PDFName, PDFString, PDFHexString } = require('pdf-lib');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PT_PER_IN = 72;

/** Standard target used across most Phase 1 tests: 6x9in, no bleed. */
const TARGET_6X9_NO_BLEED = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false };
const TARGET_6X9_WITH_BLEED = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true };

async function buildSinglePagePdf({ widthIn, heightIn, rotationDeg = 0, originX = 0, originY = 0, trimBoxIn = null, bleedBoxIn = null }) {
  const doc = await PDFDocument.create();
  const widthPt = widthIn * PT_PER_IN;
  const heightPt = heightIn * PT_PER_IN;
  const page = doc.addPage([widthPt, heightPt]);

  if (originX !== 0 || originY !== 0) {
    // Re-express MediaBox with a non-zero origin: [originX, originY,
    // originX+widthPt, originY+heightPt] — pdf-lib's addPage always
    // starts at (0,0), so this is set explicitly afterward.
    page.setMediaBox(originX, originY, widthPt, heightPt);
  }

  if (rotationDeg !== 0) {
    page.setRotation({ angle: rotationDeg, type: 'degrees' });
  }

  if (trimBoxIn) {
    page.setTrimBox(0, 0, trimBoxIn.widthIn * PT_PER_IN, trimBoxIn.heightIn * PT_PER_IN);
  }
  if (bleedBoxIn) {
    page.setBleedBox(0, 0, bleedBoxIn.widthIn * PT_PER_IN, bleedBoxIn.heightIn * PT_PER_IN);
  }

  return doc.save();
}

/** Page is already exactly the 6x9in target; no explicit TrimBox/BleedBox. */
function buildExactSizeNoBoxes() {
  return buildSinglePagePdf({ widthIn: 6, heightIn: 9 });
}

/** Page is exactly 6x9in AND already declares a consistent /TrimBox. */
function buildExactSizeConsistentTrimBox() {
  return buildSinglePagePdf({ widthIn: 6, heightIn: 9, trimBoxIn: { widthIn: 6, heightIn: 9 } });
}

/** Page is exactly 6x9in but its explicit /TrimBox disagrees (5x8). */
function buildExactSizeConflictingTrimBox() {
  return buildSinglePagePdf({ widthIn: 6, heightIn: 9, trimBoxIn: { widthIn: 5, heightIn: 8 } });
}

/** Page is 6x9.125in — trim+bleed exact match, bleed requested, no boxes declared yet. */
function buildExactSizeWithBleedNoBoxes() {
  // width = trim(6) + outer bleed(0.125); height = trim(9) + top+bottom bleed(0.25)
  return buildSinglePagePdf({ widthIn: 6.125, heightIn: 9.25 });
}

/** Page is smaller than the 6x9in target on both axes by `deficitIn`. */
function buildTooSmallPage(deficitIn) {
  return buildSinglePagePdf({ widthIn: 6 - deficitIn, heightIn: 9 - deficitIn });
}

/** Page is LARGER than the 6x9in target on both axes — must never be auto-padded. */
function buildTooLargePage() {
  return buildSinglePagePdf({ widthIn: 8.5, heightIn: 11 });
}

/** Mixed growth/shrink: wider than target but shorter than target. */
function buildMixedGrowthShrinkPage() {
  return buildSinglePagePdf({ widthIn: 7, heightIn: 8 }); // width > 6 (grow needed... no: target 6, measured 7 -> too large width), height 8 < 9 (too small height)
}

/** Page exactly the right size but rotated 90 degrees. */
function buildRotatedExactSizePage() {
  return buildSinglePagePdf({ widthIn: 6, heightIn: 9, rotationDeg: 90 });
}

/** Page exactly the right size but MediaBox has a non-zero origin. */
function buildNonZeroOriginExactSizePage() {
  return buildSinglePagePdf({ widthIn: 6, heightIn: 9, originX: 36, originY: 20 });
}

/** Two-page document: page 0 exact match, page 1 too small by 0.5in. */
async function buildMixedPageSizesDoc() {
  const doc = await PDFDocument.create();
  doc.addPage([6 * PT_PER_IN, 9 * PT_PER_IN]);
  doc.addPage([5.5 * PT_PER_IN, 8.5 * PT_PER_IN]);
  return doc.save();
}

/** Two-page document, both too small by different, small amounts (sub-threshold). */
async function buildMixedTooSmallSafeDoc() {
  const doc = await PDFDocument.create();
  doc.addPage([(6 - 0.02) * PT_PER_IN, (9 - 0.02) * PT_PER_IN]);
  doc.addPage([(6 - 0.01) * PT_PER_IN, (9 - 0.01) * PT_PER_IN]);
  return doc.save();
}

/**
 * Encrypts an arbitrary, already-built plain PDF via the system `qpdf`
 * binary (confirmed present in this environment) — pdf-lib itself cannot
 * WRITE an encrypted PDF, only read one (with ignoreEncryption:true), so
 * this is the only practical way to build a real encrypted fixture.
 */
function encryptPdfBytes(plainBytes) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdpsafe-smartfix-'));
  const inPath = path.join(tmpDir, 'plain.pdf');
  const outPath = path.join(tmpDir, 'encrypted.pdf');
  fs.writeFileSync(inPath, plainBytes);
  execFileSync('qpdf', ['--encrypt', 'owner-pw', 'user-pw', '256', '--', inPath, outPath]);
  const encrypted = fs.readFileSync(outPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return encrypted;
}

async function buildEncryptedPdf() {
  const plain = await buildExactSizeNoBoxes();
  return encryptPdfBytes(plain);
}

/**
 * Builds a PDF whose single page carries a signed (/V present) AcroForm
 * /Sig widget annotation — the same low-level construction pattern
 * already empirically proven in smart-fix-engine-gap-closure.md's
 * appendix (hand-built dict via PDFContext, registered, referenced from
 * both /AcroForm/Fields and the page's own /Annots).
 */
async function buildSignedPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([6 * PT_PER_IN, 9 * PT_PER_IN]);
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

  return doc.save();
}

/** Same shape, but the /Sig field has no /V yet (unsigned placeholder). */
async function buildUnsignedPlaceholderFieldPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([6 * PT_PER_IN, 9 * PT_PER_IN]);
  const ctx = doc.context;

  const widgetDict = ctx.obj({
    FT: 'Sig',
    Type: 'Annot',
    Subtype: 'Widget',
    Rect: ctx.obj([0, 0, 10, 10]),
    T: PDFString.of('Signature1'),
  });
  const widgetRef = ctx.register(widgetDict);

  const acroForm = ctx.obj({ Fields: ctx.obj([widgetRef]), SigFlags: 3 });
  doc.catalog.set(PDFName.of('AcroForm'), ctx.register(acroForm));
  page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));

  return doc.save();
}

module.exports = {
  TARGET_6X9_NO_BLEED,
  TARGET_6X9_WITH_BLEED,
  buildExactSizeNoBoxes,
  buildExactSizeConsistentTrimBox,
  buildExactSizeConflictingTrimBox,
  buildExactSizeWithBleedNoBoxes,
  buildTooSmallPage,
  buildTooLargePage,
  buildMixedGrowthShrinkPage,
  buildRotatedExactSizePage,
  buildNonZeroOriginExactSizePage,
  buildMixedPageSizesDoc,
  buildMixedTooSmallSafeDoc,
  buildEncryptedPdf,
  buildSignedPdf,
  buildUnsignedPlaceholderFieldPdf,
};
