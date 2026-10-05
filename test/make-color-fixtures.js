'use strict';

/**
 * Real/binary PDF fixtures for the pdfColorRewriter.js round-trip tests,
 * per the user's explicit list (2026-10-04): RGB text, RGB vector, Gray,
 * existing CMYK, nested q/Q, DeviceRGB via cs/sc, DeviceCMYK via cs/sc,
 * unsupported colorspace, inline image, mixed page.
 *
 * Built with pdf-lib's own drawing/operator API (same convention as
 * make-clip-fixture.js / make-mixed-fixture.js), so each one is a real,
 * fully-structured, loadable PDF file -- not a bare content-stream
 * snippet. All fixtures use PAPER_TYPE = 'cream' (240% TAC limit) so
 * expected numbers match the already-reviewed colorRewriter.test.js cases.
 */

const fs = require('node:fs');
const {
  PDFDocument,
  StandardFonts,
  PDFOperator,
  PDFName,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  fill,
} = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

// A real, embeddable TTF with full glyph/cmap data -- unlike pdf-lib's
// StandardFonts (base-14, no embedded font program), this lets pdf.js
// build a real toUnicode mapping, so getTextContent() actually extracts
// the drawn text instead of returning an empty item list (see the
// "text preservation" integration gap flagged 2026-10-04).
const EMBEDDABLE_FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const PAPER_TYPE = 'cream';

// A saturated color that exceeds the cream 240% TAC limit after partial-GCR
// conversion (same value used throughout colorRewriter.test.js: raw TAC
// ~255% before clamping, clamps to exactly 240%).
const OVER_LIMIT_RGB = [0.05, 0.3, 0.05];
const OVER_LIMIT_CMYK = [0.9, 0.85, 0.1, 0.7]; // raw TAC 255%, clamps to 240%, K untouched at 0.7

/** A raw content-stream fragment for text PDFOperator can't express via a
 * normal operator+args call (an inline image's BI..ID..EI block has no
 * single trailing operator keyword -- it's dict entries + raw binary +
 * EI). pushOperators() strictly requires `instanceof PDFOperator`, so
 * this builds a real PDFOperator with an empty name and the whole literal
 * fragment as its one string arg -- PDFOperator.toString()/sizeInBytes()/
 * copyBytesInto() all handle a plain-string arg without requiring it to be
 * a PDFObject, so the fragment's exact bytes are written through verbatim
 * (plus one harmless trailing space where the empty operator name would
 * normally go). */
function rawFragment(text) {
  return PDFOperator.of('', [text]);
}

function csOp(name) {
  return PDFOperator.of('cs', [name]);
}
function scnOp(...nums) {
  return PDFOperator.of('scn', nums.map(String));
}

async function newDocWithPage() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([6 * 72, 9 * 72]);
  return { doc, page };
}

// --- 1) RGB text: pure black text set via `rg` -- exercises the K-only
// prepress override on a TEXT object inside a real BT...ET block. ---
async function buildRgbTextFixture() {
  const { doc, page } = await newDocWithPage();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const text = 'Pure black heading';
  const x = 72;
  const y = 600; // page is 9*72=648pt tall -- must stay on-page or pdf.js's getTextContent() clips it away
  const size = 18;
  page.drawText(text, { x, y, size, font, color: { type: 'RGB', red: 0, green: 0, blue: 0 } });
  const bytes = await doc.save();
  return { bytes, text, x, y, size };
}

// --- 2) RGB vector: a path fill via `rg` exceeding the cream TAC limit. ---
async function buildRgbVectorFixture() {
  const { doc, page } = await newDocWithPage();
  const rect = { x: 72, y: 400, width: 200, height: 100 };
  page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of('rg', OVER_LIMIT_RGB.map(String)),
    rectangle(rect.x, rect.y, rect.width, rect.height),
    fill(),
    popGraphicsState()
  );
  const bytes = await doc.save();
  return { bytes, rect };
}

// --- 3) Gray: a mid-gray path fill via `g` -- always within TAC (max
// possible TAC from gray alone is 100%), demonstrates the 'safe, untouched'
// passthrough case in a real PDF. ---
async function buildGrayFixture() {
  const { doc, page } = await newDocWithPage();
  const rect = { x: 72, y: 400, width: 200, height: 100 };
  page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of('g', ['0.5']),
    rectangle(rect.x, rect.y, rect.width, rect.height),
    fill(),
    popGraphicsState()
  );
  const bytes = await doc.save();
  return { bytes, rect };
}

// --- 4) Existing CMYK: a path fill via `k` already exceeding TAC --
// exercises processCmyk's direct CMYK path (no RGB round-trip), operator
// must remain `k`. ---
async function buildExistingCmykFixture() {
  const { doc, page } = await newDocWithPage();
  const rect = { x: 72, y: 400, width: 200, height: 100 };
  page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of('k', OVER_LIMIT_CMYK.map(String)),
    rectangle(rect.x, rect.y, rect.width, rect.height),
    fill(),
    popGraphicsState()
  );
  const bytes = await doc.save();
  return { bytes, rect };
}

// --- 5) Nested q/Q: two rectangles, outer graphics-state level sets a
// pure-black path fill (forced K-only), an inner nested q...Q sets an
// over-limit saturated fill (autofix) that must NOT leak its color state
// back out to the outer level afterward. ---
async function buildNestedQQFixture() {
  const { doc, page } = await newDocWithPage();
  const outerRect = { x: 72, y: 500, width: 150, height: 80 };
  const innerRect = { x: 72, y: 350, width: 150, height: 80 };
  page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of('rg', ['0', '0', '0']),
    rectangle(outerRect.x, outerRect.y, outerRect.width, outerRect.height),
    fill(),
    pushGraphicsState(),
    PDFOperator.of('rg', OVER_LIMIT_RGB.map(String)),
    rectangle(innerRect.x, innerRect.y, innerRect.width, innerRect.height),
    fill(),
    popGraphicsState(),
    popGraphicsState()
  );
  const bytes = await doc.save();
  return { bytes, outerRect, innerRect };
}

// --- 6) DeviceRGB via cs/scn: a path fill through the Tier-2 generic
// operator pair, over the TAC limit -- must patch exactly like `rg`. ---
async function buildDeviceRgbCsScnFixture() {
  const { doc, page } = await newDocWithPage();
  const rect = { x: 72, y: 400, width: 200, height: 100 };
  page.pushOperators(
    pushGraphicsState(),
    csOp('/DeviceRGB'),
    scnOp(...OVER_LIMIT_RGB),
    rectangle(rect.x, rect.y, rect.width, rect.height),
    fill(),
    popGraphicsState()
  );
  const bytes = await doc.save();
  return { bytes, rect };
}

// --- 7) DeviceCMYK via cs/scn: same Tier-2 pair, CMYK, over the limit --
// must patch via processCmyk, staying on scn's own fill operator form (k). ---
async function buildDeviceCmykCsScnFixture() {
  const { doc, page } = await newDocWithPage();
  const rect = { x: 72, y: 400, width: 200, height: 100 };
  page.pushOperators(
    pushGraphicsState(),
    csOp('/DeviceCMYK'),
    scnOp(...OVER_LIMIT_CMYK),
    rectangle(rect.x, rect.y, rect.width, rect.height),
    fill(),
    popGraphicsState()
  );
  const bytes = await doc.save();
  return { bytes, rect };
}

// --- 8) Unsupported colorspace: `/CS0 cs` -- a named/resource-indirected
// space the rewriter cannot resolve from content-stream bytes alone --
// must be left byte-for-byte untouched and flagged, never guessed. ---
async function buildUnsupportedColorspaceFixture() {
  const { doc, page } = await newDocWithPage();
  const rect = { x: 72, y: 400, width: 200, height: 100 };
  page.pushOperators(
    pushGraphicsState(),
    csOp('/CS0'),
    scnOp(0.1, 0.2, 0.3),
    rectangle(rect.x, rect.y, rect.width, rect.height),
    fill(),
    popGraphicsState()
  );
  const bytes = await doc.save();
  return { bytes, rect };
}

// --- 9) Inline image: a tiny BI..ID..EI block sitting between two ordinary
// color operators -- the image's raw bytes (including a byte sequence that
// looks like a color operator) must survive byte-for-byte, and the
// surrounding real color operator must still be patched normally. ---
async function buildInlineImageFixture() {
  const { doc, page } = await newDocWithPage();
  const rect = { x: 72, y: 400, width: 200, height: 100 };
  // 2x2, 8-bit grayscale inline image; payload deliberately contains the
  // bytes "0 0 0 rg" to prove the tokenizer never looks inside it.
  const payload = Buffer.from('0 0 0 rg deadbeef');
  const inlineImageText = `BI /W 2 /H 2 /BPC 8 /CS /G ID ${payload.toString('latin1')} EI`;
  page.pushOperators(
    pushGraphicsState(),
    rawFragment(inlineImageText),
    PDFOperator.of('rg', OVER_LIMIT_RGB.map(String)),
    rectangle(rect.x, rect.y, rect.width, rect.height),
    fill(),
    popGraphicsState()
  );
  const bytes = await doc.save();
  return { bytes, rect, payload, inlineImageText };
}

// --- 10) Mixed page: one of everything above (minus the inline image,
// kept to its own fixture) on a single page, as an integration smoke test. ---
async function buildMixedPageFixture() {
  const { doc, page } = await newDocWithPage();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const text = 'Mixed-page heading';
  const textX = 72;
  const textY = 610; // page is 9*72=648pt tall -- must stay on-page or pdf.js's getTextContent() clips it away
  page.drawText(text, { x: textX, y: textY, size: 16, font, color: { type: 'RGB', red: 0, green: 0, blue: 0 } });

  const rgbRect = { x: 72, y: 520, width: 150, height: 60 };
  const grayRect = { x: 72, y: 440, width: 150, height: 60 };
  const cmykRect = { x: 72, y: 360, width: 150, height: 60 };
  const unsupportedRect = { x: 72, y: 280, width: 150, height: 60 };

  page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of('rg', OVER_LIMIT_RGB.map(String)),
    rectangle(rgbRect.x, rgbRect.y, rgbRect.width, rgbRect.height),
    fill(),
    popGraphicsState(),

    pushGraphicsState(),
    PDFOperator.of('g', ['0.5']),
    rectangle(grayRect.x, grayRect.y, grayRect.width, grayRect.height),
    fill(),
    popGraphicsState(),

    pushGraphicsState(),
    PDFOperator.of('k', OVER_LIMIT_CMYK.map(String)),
    rectangle(cmykRect.x, cmykRect.y, cmykRect.width, cmykRect.height),
    fill(),
    popGraphicsState(),

    pushGraphicsState(),
    csOp('/CS0'),
    scnOp(0.1, 0.2, 0.3),
    rectangle(unsupportedRect.x, unsupportedRect.y, unsupportedRect.width, unsupportedRect.height),
    fill(),
    popGraphicsState()
  );

  const bytes = await doc.save();
  return { bytes, text, textX, textY, rgbRect, grayRect, cmykRect, unsupportedRect };
}

// --- 11) Multi-stream /Contents: a page whose content is split across 3
// separate indirect stream objects (not pdf-lib's usual single
// accumulated content stream), with color state spanning the boundaries:
// stream 1 opens `q` and sets `/DeviceRGB cs` but closes neither; stream 2
// fills over the TAC limit via `scn` under that still-open state; stream 3
// closes the `q` (`Q`) and then attempts another `scn` fill with NO active
// color space -- which must be silently skipped (not misread as still
// being DeviceRGB) because the Q correctly reverted the state. Built via
// pdf-lib's low-level context API directly (context.stream + a raw
// /Contents array), since pdf-lib's own page-building API always
// accumulates everything into one content stream. ---
async function buildMultiStreamFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([6 * 72, 9 * 72]);
  const context = doc.context;
  const rect1 = { x: 72, y: 400, width: 200, height: 100 };
  const rect2 = { x: 72, y: 200, width: 50, height: 50 };

  const s1 = context.register(context.stream('q\n/DeviceRGB cs\n'));
  const s2 = context.register(
    context.stream(`${OVER_LIMIT_RGB.join(' ')} scn\n${rect1.x} ${rect1.y} ${rect1.width} ${rect1.height} re f\n`)
  );
  const s3 = context.register(
    context.stream(`Q\n0.2 0.3 0.4 scn\n${rect2.x} ${rect2.y} ${rect2.width} ${rect2.height} re f\n`)
  );
  page.node.set(PDFName.of('Contents'), context.obj([s1, s2, s3]));

  const bytes = await doc.save();
  return { bytes, rect1, rect2 };
}

// --- 12) Text preservation: a real embedded TTF (not pdf-lib's
// StandardFonts base-14) so pdf.js's getTextContent() can build a genuine
// toUnicode mapping and extract the actual drawn string -- a direct
// extract(input) === extract(output) check, not just "both empty". The
// text itself is pure black (K-only override fires), so this also proves
// the color patch doesn't disturb text extraction. ---
async function buildExtractableTextFixture() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontBytes = fs.readFileSync(EMBEDDABLE_FONT_PATH);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const page = doc.addPage([6 * 72, 9 * 72]);
  const text = 'Extractable text QA';
  const x = 72;
  const y = 600; // page is 9*72=648pt tall -- must stay on-page or pdf.js's getTextContent() clips it away
  const size = 20;
  page.drawText(text, { x, y, size, font, color: { type: 'RGB', red: 0, green: 0, blue: 0 } });
  const bytes = await doc.save();
  return { bytes, text, x, y, size };
}

module.exports = {
  PAPER_TYPE,
  OVER_LIMIT_RGB,
  OVER_LIMIT_CMYK,
  buildRgbTextFixture,
  buildRgbVectorFixture,
  buildGrayFixture,
  buildExistingCmykFixture,
  buildNestedQQFixture,
  buildDeviceRgbCsScnFixture,
  buildDeviceCmykCsScnFixture,
  buildUnsupportedColorspaceFixture,
  buildInlineImageFixture,
  buildMixedPageFixture,
  buildMultiStreamFixture,
  buildExtractableTextFixture,
};
