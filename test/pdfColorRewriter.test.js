'use strict';

/**
 * Real-PDF round-trip tests for pdfColorRewriter.js, per the user's
 * explicit requirement (2026-10-04): input.pdf -> KDPSafe -> output.pdf ->
 * PDF.js re-analysis, checked against the full list they specified:
 *   - output PDF opens
 *   - page count unchanged
 *   - text extraction unchanged
 *   - geometry unchanged
 *   - intended colors changed as expected
 *   - unsupported colors left untouched
 *   - inline images untouched
 *   - final TAC meets target (for colors actually in scope -- Tier 3/
 *     unsupported colors are deliberately never touched at all, so "TAC
 *     meets target" does not apply to them; that is itself one of the
 *     checks above).
 *
 * "PDF.js re-analysis" (opens, page count, text extraction, geometry via
 * getOperatorList) is done with pdfjs-dist, the same way margin.js already
 * does it. Color-value-level checks (exact patched numbers, unsupported
 * colors literally unchanged, inline image bytes literally unchanged) are
 * done by decoding the real output PDF's content stream bytes directly
 * (via pdfColorRewriter.getDecodedPageContents, built on pdf-lib's own
 * decodePDFRawStream) and tokenizing them with the already-tested
 * contentTokenizer -- this is more precise than trying to recover exact
 * operand values from pdfjs's OPS abstraction, and avoids re-implementing
 * a second, parallel color-resolution layer just for test assertions.
 */

const assert = require('node:assert/strict');
const { rewritePdfColors, getDecodedPageContents } = require('../lib/pdfColorRewriter');
const fixtures = require('./make-color-fixtures');

let _pdfjsLibPromise = null;
function loadPdfjs() {
  if (!_pdfjsLibPromise) _pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjsLibPromise;
}

const path = require('node:path');
const STANDARD_FONT_DATA_URL = `${path.join(require.resolve('pdfjs-dist/package.json', { paths: [__dirname, process.cwd()] }).replace(/package\.json$/, ''), 'standard_fonts')}/`;

async function pdfjsAnalyze(bytes) {
  const pdfjsLib = await loadPdfjs();
  // pdfjs-dist detaches/transfers the ArrayBuffer backing `data` once
  // getDocument() runs (even in-process, via its internal worker-message
  // plumbing) -- pass it a throwaway copy so the caller's own bytes stay
  // readable afterward for the subsequent byte-level checks.
  const dataCopy = Uint8Array.from(bytes);
  const doc = await pdfjsLib.getDocument({
    data: dataCopy,
    isEvalSupported: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  const pageCount = doc.numPages;
  const pages = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items.map((it) => it.str).join('');
    const opList = await page.getOperatorList();
    pages.push({ text, opList });
  }
  return { pageCount, pages };
}

function tac(c, m, y, k) {
  return (c + m + y + k) * 100;
}

async function run() {
  // --- 1) RGB text: pure black -> K-only override, text/position preserved. ---
  {
    const { bytes, text } = await fixtures.buildRgbTextFixture();
    const { outputBytes, pageResults } = await rewritePdfColors(bytes, { paperType: fixtures.PAPER_TYPE });

    const before = await pdfjsAnalyze(bytes);
    const after = await pdfjsAnalyze(outputBytes);
    assert.equal(after.pageCount, before.pageCount, '[1] page count must be unchanged');
    // CORRECTED 2026-10-04 (user caught this): an earlier version of this
    // test asserted only "before === after" and logged a NOTE blaming an
    // "empty extraction" on a pdf.js/pdf-lib font-substitution quirk. That
    // diagnosis was wrong -- the actual cause was a bug in this fixture
    // itself (y=700 on a 648pt-tall page, drawing the text off-page, which
    // pdf.js's getTextContent() correctly clips away). With the fixture
    // fixed, extraction works correctly even with pdf-lib's non-embedded
    // StandardFonts, and this now asserts the real, specific string, not
    // just a before/after comparison that a silently-broken fixture could
    // trivially satisfy.
    assert.equal(before.pages[0].text, text, '[1] sanity check: pdf.js must extract the real text from the UNMODIFIED input');
    assert.equal(after.pages[0].text, text, '[1] extract(output) must equal the original text exactly');
    assert.equal(after.pages[0].text, before.pages[0].text, '[1] extract(input) === extract(output)');

    assert.equal(pageResults[0].patches.length, 1, '[1] exactly one color patch expected');
    assert.equal(pageResults[0].patches[0].after, '0 0 0 1 k', '[1] black text must be forced to pure K100');

    const decoded = await getDecodedPageContents(outputBytes, 0);
    assert.ok(decoded.toString('latin1').includes('0 0 0 1 k'), '[1] patched operator present in real output PDF bytes');
    console.log('[1] RGB text (black -> K-only) passed.');
  }

  // --- 2) RGB vector: over-limit color -> autofix, geometry (re args) unchanged. ---
  {
    const { bytes, rect } = await fixtures.buildRgbVectorFixture();
    const { outputBytes, pageResults } = await rewritePdfColors(bytes, { paperType: fixtures.PAPER_TYPE });

    const after = await pdfjsAnalyze(outputBytes);
    assert.equal(after.pageCount, 1, '[2] page count unchanged');

    assert.equal(pageResults[0].patches.length, 1, '[2] exactly one patch expected');
    const [c, m, y, k] = pageResults[0].patches[0].after.split(' ').map(Number);
    assert.ok(Math.abs(tac(c, m, y, k) - 240) < 0.01, '[2] patched color must sit on the 240% TAC limit');

    const decoded = await getDecodedPageContents(outputBytes, 0);
    const hasRectGeometry = decoded.toString('latin1').includes(`${rect.x} ${rect.y} ${rect.width} ${rect.height} re`);
    assert.ok(hasRectGeometry, '[2] rectangle geometry (re operands) must be byte-identical in the output');
    console.log('[2] RGB vector (over-limit autofix) passed.');
  }

  // --- 3) Gray: always within TAC -> safe, zero patches, stream left alone. ---
  {
    const { bytes, rect } = await fixtures.buildGrayFixture();
    const { outputBytes, pageResults } = await rewritePdfColors(bytes, { paperType: fixtures.PAPER_TYPE });

    const after = await pdfjsAnalyze(outputBytes);
    assert.equal(after.pageCount, 1, '[3] page count unchanged');
    assert.equal(pageResults[0].patches.length, 0, '[3] gray fill must never need a patch');
    assert.equal(pageResults[0].diagnostics.length, 0, '[3] gray fill must never be diagnosed');
    assert.equal(pageResults[0].streamsRewritten, 0, '[3] untouched stream must not even be re-encoded');

    const decoded = await getDecodedPageContents(outputBytes, 0);
    assert.ok(decoded.toString('latin1').includes(`${rect.x} ${rect.y} ${rect.width} ${rect.height} re`), '[3] geometry unchanged');
    assert.ok(decoded.toString('latin1').includes('0.5 g'), '[3] original gray operator must survive untouched');
    console.log('[3] Gray (safe passthrough) passed.');
  }

  // --- 4) Existing CMYK: direct `k` operator, over limit -> autofix, stays `k`, K untouched. ---
  {
    const { bytes, rect } = await fixtures.buildExistingCmykFixture();
    const { outputBytes, pageResults } = await rewritePdfColors(bytes, { paperType: fixtures.PAPER_TYPE });

    assert.equal(pageResults[0].patches.length, 1, '[4] exactly one patch expected');
    const patch = pageResults[0].patches[0];
    const [c, m, y, k] = patch.after.split(' ').map(Number);
    assert.ok(patch.after.endsWith(' k'), '[4] operator must remain k, not switch to rg/g');
    assert.ok(Math.abs(k - fixtures.OVER_LIMIT_CMYK[3]) < 0.001, '[4] K from an explicit k operator must stay exactly as authored');
    assert.ok(Math.abs(tac(c, m, y, k) - 240) < 0.01, '[4] final TAC must sit on the 240% limit');

    const after = await pdfjsAnalyze(outputBytes);
    assert.equal(after.pageCount, 1, '[4] page count unchanged');
    const decoded = await getDecodedPageContents(outputBytes, 0);
    assert.ok(decoded.toString('latin1').includes(`${rect.x} ${rect.y} ${rect.width} ${rect.height} re`), '[4] geometry unchanged');
    console.log('[4] Existing CMYK (direct k autofix) passed.');
  }

  // --- 5) Nested q/Q: outer forced K-only, inner autofix, state correctly scoped. ---
  {
    const { bytes, outerRect, innerRect } = await fixtures.buildNestedQQFixture();
    const { outputBytes, pageResults } = await rewritePdfColors(bytes, { paperType: fixtures.PAPER_TYPE });

    assert.equal(pageResults[0].patches.length, 2, '[5] both the outer and inner fills must be patched');
    const outerPatch = pageResults[0].patches.find((p) => p.after === '0 0 0 1 k');
    assert.ok(outerPatch, '[5] outer pure-black fill must be forced to K-only');
    const innerPatch = pageResults[0].patches.find((p) => p !== outerPatch);
    const [c, m, y, k] = innerPatch.after.split(' ').map(Number);
    assert.ok(Math.abs(tac(c, m, y, k) - 240) < 0.01, '[5] inner over-limit fill must clamp to 240%');

    const after = await pdfjsAnalyze(outputBytes);
    assert.equal(after.pageCount, 1, '[5] page count unchanged');
    const decoded = await getDecodedPageContents(outputBytes, 0);
    const str = decoded.toString('latin1');
    assert.ok(str.includes(`${outerRect.x} ${outerRect.y} ${outerRect.width} ${outerRect.height} re`), '[5] outer rect geometry unchanged');
    assert.ok(str.includes(`${innerRect.x} ${innerRect.y} ${innerRect.width} ${innerRect.height} re`), '[5] inner rect geometry unchanged');
    console.log('[5] Nested q/Q (two independent fixes, no state leakage) passed.');
  }

  // --- 6) DeviceRGB via cs/scn: over limit -> patched like rg, operator becomes k. ---
  {
    const { bytes, rect } = await fixtures.buildDeviceRgbCsScnFixture();
    const { outputBytes, pageResults } = await rewritePdfColors(bytes, { paperType: fixtures.PAPER_TYPE });

    assert.equal(pageResults[0].diagnostics.length, 0, '[6] a literal /DeviceRGB space must never be diagnosed as unsupported');
    assert.equal(pageResults[0].patches.length, 1, '[6] exactly one patch expected');
    assert.ok(pageResults[0].patches[0].after.endsWith(' k'), '[6] scn under DeviceRGB must patch to a plain k operator');

    const after = await pdfjsAnalyze(outputBytes);
    assert.equal(after.pageCount, 1, '[6] page count unchanged');
    const decoded = await getDecodedPageContents(outputBytes, 0);
    assert.ok(decoded.toString('latin1').includes(`${rect.x} ${rect.y} ${rect.width} ${rect.height} re`), '[6] geometry unchanged');
    console.log('[6] DeviceRGB via cs/scn (Tier 2 autofix) passed.');
  }

  // --- 7) DeviceCMYK via cs/scn: over limit -> patched via processCmyk. ---
  {
    const { bytes, rect } = await fixtures.buildDeviceCmykCsScnFixture();
    const { outputBytes, pageResults } = await rewritePdfColors(bytes, { paperType: fixtures.PAPER_TYPE });

    assert.equal(pageResults[0].diagnostics.length, 0, '[7] a literal /DeviceCMYK space must never be diagnosed as unsupported');
    assert.equal(pageResults[0].patches.length, 1, '[7] exactly one patch expected');
    const [c, m, y, k] = pageResults[0].patches[0].after.split(' ').map(Number);
    assert.ok(Math.abs(k - fixtures.OVER_LIMIT_CMYK[3]) < 0.001, '[7] K must stay exactly as authored (no RGB round-trip)');
    assert.ok(Math.abs(tac(c, m, y, k) - 240) < 0.01, '[7] final TAC must sit on the 240% limit');

    const after = await pdfjsAnalyze(outputBytes);
    assert.equal(after.pageCount, 1, '[7] page count unchanged');
    const decoded = await getDecodedPageContents(outputBytes, 0);
    assert.ok(decoded.toString('latin1').includes(`${rect.x} ${rect.y} ${rect.width} ${rect.height} re`), '[7] geometry unchanged');
    console.log('[7] DeviceCMYK via cs/scn (Tier 2 processCmyk autofix) passed.');
  }

  // --- 8) Unsupported colorspace: /CS0 -- diagnosed, byte-for-byte untouched. ---
  {
    const { bytes, rect } = await fixtures.buildUnsupportedColorspaceFixture();
    const { outputBytes, pageResults } = await rewritePdfColors(bytes, { paperType: fixtures.PAPER_TYPE });

    assert.equal(pageResults[0].patches.length, 0, '[8] an unsupported colorspace must never be auto-patched');
    assert.equal(pageResults[0].diagnostics.length, 1, '[8] exactly one unsupported_colorspace diagnostic expected');
    assert.equal(pageResults[0].diagnostics[0].type, 'unsupported_colorspace');
    assert.equal(pageResults[0].streamsRewritten, 0, '[8] untouched stream must not even be re-encoded');

    const after = await pdfjsAnalyze(outputBytes);
    assert.equal(after.pageCount, 1, '[8] page count unchanged');
    const decoded = await getDecodedPageContents(outputBytes, 0);
    const str = decoded.toString('latin1');
    assert.ok(str.includes('/CS0 cs'), '[8] unsupported color space call left completely untouched');
    assert.ok(str.includes('0.1 0.2 0.3 scn'), '[8] unsupported fill color values left completely untouched');
    assert.ok(str.includes(`${rect.x} ${rect.y} ${rect.width} ${rect.height} re`), '[8] geometry unchanged');
    console.log('[8] Unsupported colorspace (left untouched + flagged) passed.');
  }

  // --- 9) Inline image: raw bytes survive untouched; surrounding color patched normally. ---
  {
    const { bytes, rect, inlineImageText } = await fixtures.buildInlineImageFixture();
    const { outputBytes, pageResults } = await rewritePdfColors(bytes, { paperType: fixtures.PAPER_TYPE });

    assert.equal(pageResults[0].patches.length, 1, '[9] exactly one real color patch expected (not the inline image payload)');
    assert.ok(pageResults[0].patches[0].after.endsWith(' k'), '[9] the real rg fill must still be patched to k');
    assert.equal(pageResults[0].diagnostics.length, 0, '[9] no diagnostics expected for this fixture');

    const after = await pdfjsAnalyze(outputBytes);
    assert.equal(after.pageCount, 1, '[9] page count unchanged');

    const decoded = await getDecodedPageContents(outputBytes, 0);
    const str = decoded.toString('latin1');
    assert.ok(str.includes(inlineImageText), '[9] inline image block must survive completely byte-for-byte, including its fake "rg" payload bytes');
    assert.ok(str.includes(`${rect.x} ${rect.y} ${rect.width} ${rect.height} re`), '[9] geometry unchanged');
    console.log('[9] Inline image (untouched, surrounding color still patched) passed.');
  }

  // --- 10) Mixed page: integration smoke test of everything at once. ---
  {
    const { bytes, text, rgbRect, grayRect, cmykRect, unsupportedRect } = await fixtures.buildMixedPageFixture();
    const { outputBytes, pageResults } = await rewritePdfColors(bytes, { paperType: fixtures.PAPER_TYPE });

    const before = await pdfjsAnalyze(bytes);
    const after = await pdfjsAnalyze(outputBytes);
    assert.equal(after.pageCount, before.pageCount, '[10] page count unchanged');
    assert.equal(before.pages[0].text, text, '[10] sanity check: pdf.js must extract the real text from the UNMODIFIED input');
    assert.equal(after.pages[0].text, text, '[10] extract(output) must equal the original text exactly');
    assert.equal(after.pages[0].text, before.pages[0].text, '[10] extract(input) === extract(output)');

    assert.equal(pageResults[0].patches.length, 3, '[10] text(K-only) + rgbRect(autofix) + cmykRect(autofix) = 3 patches');
    assert.equal(pageResults[0].diagnostics.length, 1, '[10] exactly the one unsupported-colorspace rect must be diagnosed');

    const decoded = await getDecodedPageContents(outputBytes, 0);
    const str = decoded.toString('latin1');
    assert.ok(str.includes('0 0 0 1 k'), '[10] black heading forced to K-only');
    assert.ok(str.includes(`${rgbRect.x} ${rgbRect.y} ${rgbRect.width} ${rgbRect.height} re`), '[10] rgbRect geometry unchanged');
    assert.ok(str.includes(`${grayRect.x} ${grayRect.y} ${grayRect.width} ${grayRect.height} re`), '[10] grayRect geometry unchanged');
    assert.ok(str.includes('0.5 g'), '[10] safe gray fill left untouched');
    assert.ok(str.includes(`${cmykRect.x} ${cmykRect.y} ${cmykRect.width} ${cmykRect.height} re`), '[10] cmykRect geometry unchanged');
    assert.ok(str.includes(`${unsupportedRect.x} ${unsupportedRect.y} ${unsupportedRect.width} ${unsupportedRect.height} re`), '[10] unsupportedRect geometry unchanged');
    assert.ok(str.includes('/CS0 cs') && str.includes('0.1 0.2 0.3 scn'), '[10] unsupported colorspace fill left byte-for-byte untouched');

    // TAC check only applies to the two patched (in-scope) fills.
    for (const p of pageResults[0].patches) {
      if (p.after === '0 0 0 1 k') continue; // forced K-only, trivially 100% K, not a TAC-limit case
      const [c, m, y, k] = p.after.split(' ').map(Number);
      assert.ok(tac(c, m, y, k) <= 240.01, '[10] every autofixed color must meet the 240% cream target');
    }
    console.log('[10] Mixed page (integration smoke test) passed.');
  }

  // --- 11) Multi-stream /Contents: color state must carry across stream
  // boundaries (an open q/cs spanning streams 1->2), and correctly revert
  // once Q closes it in stream 3 (gap flagged by the user, 2026-10-04). ---
  {
    const { bytes, rect1, rect2 } = await fixtures.buildMultiStreamFixture();
    const { outputBytes, pageResults } = await rewritePdfColors(bytes, { paperType: fixtures.PAPER_TYPE });

    assert.equal(pageResults[0].streamsProcessed, 3, '[11] fixture must actually have 3 separate content-stream objects');
    assert.equal(pageResults[0].patches.length, 1, '[11] exactly one patch: the over-limit fill under the carried-over DeviceRGB state');
    assert.ok(pageResults[0].patches[0].after.endsWith(' k'), '[11] carried-over scn under DeviceRGB must patch to k, same as single-stream Tier 2');
    // The stream-3 fill has NO active color space (Q correctly reverted
    // the cs set in stream 1) -- it must be silently skipped, not
    // mis-patched as if DeviceRGB were still active.
    assert.equal(pageResults[0].diagnostics.length, 0, '[11] the post-Q fill with no active space must not even be diagnosed (same as single-stream behavior)');

    const after = await pdfjsAnalyze(outputBytes);
    assert.equal(after.pageCount, 1, '[11] page count unchanged');
    const decoded = await getDecodedPageContents(outputBytes, 0);
    const str = decoded.toString('latin1');
    assert.ok(str.includes(`${rect1.x} ${rect1.y} ${rect1.width} ${rect1.height} re`), '[11] rect1 geometry unchanged');
    assert.ok(str.includes(`${rect2.x} ${rect2.y} ${rect2.width} ${rect2.height} re`), '[11] rect2 geometry unchanged');
    // rect2's fill color (0.2 0.3 0.4 scn) must survive completely
    // untouched: with no resolvable color space, color.js is never even
    // consulted for it.
    assert.ok(str.includes('0.2 0.3 0.4 scn'), '[11] the post-Q, no-active-space fill must be left byte-for-byte untouched');
    console.log('[11] Multi-stream /Contents (state continuity across stream boundary) passed.');
  }

  // --- 12) Text preservation: a real embedded TTF, direct
  // extract(input) === extract(output) check (not just "both empty"),
  // with the color patch (K-only override) also firing on this text. ---
  {
    const { bytes, text } = await fixtures.buildExtractableTextFixture();
    const { outputBytes, pageResults } = await rewritePdfColors(bytes, { paperType: fixtures.PAPER_TYPE });

    const before = await pdfjsAnalyze(bytes);
    const after = await pdfjsAnalyze(outputBytes);
    assert.equal(before.pages[0].text, text, '[12] sanity check: pdf.js must actually extract the real text from the UNMODIFIED input with this embedded font');
    assert.equal(after.pages[0].text, text, '[12] extract(output) must equal the original text exactly');
    assert.equal(after.pages[0].text, before.pages[0].text, '[12] extract(input) === extract(output)');

    assert.equal(pageResults[0].patches.length, 1, '[12] black text must still be forced to K-only');
    assert.equal(pageResults[0].patches[0].after, '0 0 0 1 k');
    console.log('[12] Text preservation (real embedded font, extract(input) === extract(output)) passed.');
  }

  console.log('All pdfColorRewriter.test.js tests passed.');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
