'use strict';

/**
 * Real-PDF embedding for margin/LEM autofix -- CHECKPOINT 4 (2026-10-05),
 * the Phase-1 (geometry) counterpart of lib/pdfColorRewriter.js's Phase-2
 * (color) embedding layer. Deliberately NOT sharing code with that file
 * (not importing it, not modifying it) to keep Phase 1 and Phase 2 fully
 * independent, per this project's explicit scope rule -- the two happen to
 * use the same small set of pdf-lib building blocks (decodePDFRawStream,
 * PDFArray/PDFRawStream for locating a page's content-stream object(s),
 * zlib re-encoding) because that's simply how you reach and rewrite a raw
 * content stream through pdf-lib, not because of any shared dependency.
 *
 *   InspectionResult.autofixPlans (lib/orchestrator.js)
 *     -> filter to applyable:true
 *     -> locate each page's content stream object(s)
 *     -> decode -> lib/geometryRewriter.js's shiftRectInContentStream()
 *     -> re-encode with FlateDecode, fix /Length
 *     -> pdfDoc.save()
 *
 * SCOPE: only pages whose /Contents is a SINGLE stream object are
 * supported for patching (the overwhelmingly common case, and the one
 * every fixture in this repo produces). A page whose /Contents is a
 * multi-stream array is left byte-for-byte untouched and every plan
 * targeting it is reported as skipped -- not because it's unsafe in
 * principle, but because this file doesn't yet thread geometryRewriter's
 * CTM/clip tracking across stream-object boundaries the way
 * pdfColorRewriter.js's color pass does for its own, unrelated state. A
 * future checkpoint can extend this; this one does not guess across a
 * boundary it hasn't actually handled.
 *
 * Never mutates the caller's `pdfBytes` -- every call loads a fresh pdf-lib
 * document from it and only ever writes into buffers this module allocates
 * itself (`Buffer.from(decodePDFRawStream(...).decode())` always copies).
 */

const zlib = require('zlib');
const { PDFDocument, PDFArray, PDFRawStream, PDFName, PDFNumber, decodePDFRawStream } = require('pdf-lib');
const { shiftRectInContentStream } = require('./geometryRewriter');

/**
 * Resolve a page's content-stream objects as an ordered list of
 * { ref, stream } entries -- mirrors lib/pdfColorRewriter.js's own helper
 * of the same purpose (duplicated, not imported, per this file's header).
 */
function getContentStreamEntries(page, context) {
  const contentsValue = page.node.get(PDFName.of('Contents'));
  const contents = page.node.Contents();

  if (contents instanceof PDFArray) {
    const entries = [];
    for (let idx = 0; idx < contents.size(); idx++) {
      const ref = contents.get(idx);
      const stream = context.lookup(ref);
      if (stream instanceof PDFRawStream) entries.push({ ref, stream });
    }
    return entries;
  }

  if (contents instanceof PDFRawStream) {
    return [{ ref: contentsValue, stream: contents }];
  }

  return [];
}

/**
 * @param {Uint8Array|Buffer} pdfBytes
 * @param {object} inspectionResult  a runPreflight() result carrying
 *   `.autofixPlans` (see lib/orchestrator.js)
 * @returns {Promise<{
 *   outputBytes: Uint8Array,
 *   applied: Array<{plan: object, patch: object}>,
 *   skipped: Array<{plan: object, reason: string}>,
 * }>}
 */
async function applyAutofix(pdfBytes, inspectionResult) {
  const plans = (inspectionResult.autofixPlans || []).filter((p) => p.applyable);
  const applied = [];
  const skipped = [];

  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

  if (plans.length === 0) {
    const outputBytes = await doc.save();
    return { outputBytes, applied, skipped };
  }

  const context = doc.context;
  const pages = doc.getPages();

  const byPage = new Map();
  for (const plan of plans) {
    if (!byPage.has(plan.pageIndex)) byPage.set(plan.pageIndex, []);
    byPage.get(plan.pageIndex).push(plan);
  }

  for (const [pageIndex, pagePlans] of byPage) {
    const page = pages[pageIndex];
    if (!page) {
      for (const plan of pagePlans) skipped.push({ plan, reason: 'page_not_found' });
      continue;
    }

    const entries = getContentStreamEntries(page, context);
    if (entries.length === 0) {
      for (const plan of pagePlans) skipped.push({ plan, reason: 'no_content_stream' });
      continue;
    }
    if (entries.length > 1) {
      for (const plan of pagePlans) skipped.push({ plan, reason: 'multi_stream_contents_unsupported' });
      continue;
    }

    const { stream } = entries[0];
    let buf = Buffer.from(decodePDFRawStream(stream).decode());
    let changed = false;

    for (const plan of pagePlans) {
      const result = shiftRectInContentStream(buf, {
        targetRawBBoxPt: plan.rawBBoxPt,
        dx: plan.shift.dx,
        dy: plan.shift.dy,
      });

      if (result.status === 'applied') {
        buf = result.patchedBytes;
        changed = true;
        applied.push({ plan, patch: result.patch });
      } else {
        skipped.push({
          plan,
          reason: result.status === 'ambiguous' ? 'ambiguous_rect_match' : 'rect_not_found',
        });
      }
    }

    if (changed) {
      const recompressed = zlib.deflateSync(buf);
      stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
      stream.dict.delete(PDFName.of('DecodeParms'));
      stream.dict.delete(PDFName.of('DP'));
      stream.contents = new Uint8Array(recompressed);
      stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.getContentsSize()));
    }
  }

  const outputBytes = await doc.save();
  return { outputBytes, applied, skipped };
}

module.exports = { applyAutofix, getContentStreamEntries };
