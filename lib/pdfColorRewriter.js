/**
 * Real-PDF embedding for the content-stream color rewriter.
 *
 * This is the integration layer requested by the user (2026-10-04, their own
 * message, not a Freya relay) on top of the already-tested
 * colorRewriter.js/contentTokenizer.js pipeline:
 *
 *   input PDF bytes
 *     -> pdf-lib: locate each page's content stream object(s)
 *     -> decode (FlateDecode or whatever filter chain is present, via
 *        pdf-lib's own decodePDFRawStream -- handles Flate/LZW/ASCII85/
 *        ASCIIHex/RunLength and filter arrays)
 *     -> rewriteContentStreamColors (the existing, tested parse->decide->
 *        patch pipeline) -- UNCHANGED, not modified for this phase
 *     -> re-encode with FlateDecode (Node's zlib, which produces the same
 *        zlib/deflate container the /FlateDecode filter expects)
 *     -> write the new bytes + dict (/Filter /FlateDecode, /Length fixed)
 *        back onto the SAME stream object pdf-lib already has registered,
 *        so every other indirect object in the document -- fonts, images,
 *        the page tree, the resources dict, annotations, etc. -- is never
 *        touched
 *     -> pdfDoc.save() produces the final, valid output PDF.
 *
 * SCOPE (per the user's explicit "не розширювати colorspace scope"):
 *   - Does NOT change rewriteContentStreamColors' own Tier 1/2/3 boundaries
 *     at all -- this module only moves bytes in and out of real PDF stream
 *     objects.
 *   - A stream with zero patches/diagnostics-worthy changes is left
 *     completely alone (not even re-encoded), to disturb as little of the
 *     original file as possible.
 *   - Multi-stream /Contents arrays: per the PDF spec (7.8.2), an array of
 *     content streams is logically ONE continuous token stream -- a single
 *     operator never spans a stream boundary, but graphics/color *state*
 *     (an open q, the active cs/CS space, an open BT) legitimately does.
 *     This module threads rewriteContentStreamColors' state (fillSpace/
 *     strokeSpace/stateStack/inTextBlock) from one stream to the next, in
 *     document order, via opts.initialState/result.finalState, so a page
 *     whose color state genuinely spans several stream objects is still
 *     rewritten correctly rather than silently treated as several
 *     independent, state-reset streams. Covered by the "multi-stream"
 *     fixture in test/make-color-fixtures.js (2026-10-04 follow-up).
 *   - Image XObjects and inline images remain entirely untouched, exactly
 *     as rewriteContentStreamColors already leaves them (out of scope).
 */

'use strict';

const zlib = require('zlib');
const {
  PDFDocument,
  PDFArray,
  PDFRawStream,
  PDFName,
  PDFNumber,
  decodePDFRawStream,
} = require('pdf-lib');
const { rewriteContentStreamColors } = require('./colorRewriter');

/**
 * Resolve a page's content-stream objects as a flat, ordered list of
 * { ref, stream } entries. Handles both the normalized (/Contents is an
 * array of indirect refs) and non-normalized (/Contents is a single
 * indirect stream) cases that pdf-lib can hand back from Contents().
 */
function getContentStreamEntries(page, context) {
  const contentsValue = page.node.get(PDFName.of('Contents'));
  const contents = page.node.Contents();
  const entries = [];

  if (contents instanceof PDFArray) {
    for (let idx = 0; idx < contents.size(); idx++) {
      const ref = contents.get(idx);
      const stream = context.lookup(ref);
      if (stream instanceof PDFRawStream) entries.push({ ref, stream });
    }
    return entries;
  }

  // Non-normalized: a single content stream, referenced indirectly.
  if (contents instanceof PDFRawStream) {
    entries.push({ ref: contentsValue, stream: contents });
  }
  return entries;
}

/**
 * @param {Uint8Array|Buffer} inputBytes  a full PDF file's bytes
 * @param {Object} opts
 * @param {string} [opts.paperType]  passed straight through to
 *        rewriteContentStreamColors / color.js's policy functions
 * @returns {Promise<{
 *   outputBytes: Uint8Array,
 *   pageResults: Array<{
 *     pageIndex: number,
 *     streamsProcessed: number,
 *     streamsRewritten: number,
 *     patches: Array,
 *     diagnostics: Array,
 *   }>,
 * }>}
 */
async function rewritePdfColors(inputBytes, opts = {}) {
  const pdfDoc = await PDFDocument.load(inputBytes, {
    updateMetadata: false,
    // Fixtures are our own, never encrypted, but don't let an unrelated
    // encryption dictionary abort a color-correction pass.
    ignoreEncryption: true,
  });
  const context = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const pageResults = [];

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const entries = getContentStreamEntries(page, context);
    const result = {
      pageIndex,
      streamsProcessed: entries.length,
      streamsRewritten: 0,
      patches: [],
      diagnostics: [],
    };

    // Per the PDF spec (7.8.2), a /Contents array is logically ONE token
    // stream split arbitrarily across several stream objects: an operator
    // never spans a boundary, but graphics/color state (open q's, the
    // active cs/CS space, an open BT) legitimately can. Thread
    // rewriteContentStreamColors' state through each stream on this page
    // in document order so a page split this way is rewritten correctly
    // instead of silently resetting state at each boundary (closing the
    // gap the user flagged, 2026-10-04).
    let carriedState = undefined;

    for (const { stream } of entries) {
      const decoded = decodePDFRawStream(stream).decode();
      const buf = Buffer.from(decoded);
      const { patchedBytes, patches, diagnostics, finalState } = rewriteContentStreamColors(buf, {
        ...opts,
        initialState: carriedState,
      });
      carriedState = finalState;

      for (const p of patches) result.patches.push({ ...p, pageIndex });
      for (const d of diagnostics) result.diagnostics.push({ ...d, pageIndex });

      if (patches.length === 0) {
        // Nothing changed in this stream -- leave the object byte-for-byte
        // as pdf-lib parsed it. Do not even re-encode: a no-op re-deflate
        // would still be semantically harmless, but touching the object at
        // all is unnecessary and works against "preserve everything else
        // unchanged."
        continue;
      }

      const recompressed = zlib.deflateSync(patchedBytes);
      stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
      stream.dict.delete(PDFName.of('DecodeParms'));
      stream.dict.delete(PDFName.of('DP'));
      stream.contents = new Uint8Array(recompressed);
      // pdf-lib recomputes /Length from getContentsSize() on save, but set
      // it explicitly too -- the correctness requirement was explicit
      // ("коректне оновлення /Length"), so this should not depend silently
      // on an internal library behavior going unchanged.
      stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.getContentsSize()));

      result.streamsRewritten += 1;
    }

    pageResults.push(result);
  }

  const outputBytes = await pdfDoc.save();
  return { outputBytes, pageResults };
}

/**
 * Verification helper (not used by rewritePdfColors itself): decode and
 * concatenate every content-stream object on one page back into a single
 * buffer, in document order, with a separating space -- mirroring how the
 * PDF spec treats a /Contents array as one logical token stream. Used by
 * the round-trip tests to inspect exactly what operators/colors a page
 * contains after rewriting, independent of pdfjs-dist's own operator-list
 * abstraction.
 *
 * @param {Uint8Array|Buffer} pdfBytes
 * @param {number} pageIndex 0-based
 * @returns {Promise<Buffer>}
 */
async function getDecodedPageContents(pdfBytes, pageIndex) {
  const pdfDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false, ignoreEncryption: true });
  const page = pdfDoc.getPages()[pageIndex];
  const entries = getContentStreamEntries(page, pdfDoc.context);
  const parts = entries.map((e) => Buffer.from(decodePDFRawStream(e.stream).decode()));
  return Buffer.concat(parts.flatMap((p, i) => (i === 0 ? [p] : [Buffer.from(' '), p])));
}

module.exports = { rewritePdfColors, getDecodedPageContents };
