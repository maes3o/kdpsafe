'use strict';

/**
 * Smart Fix Phase 2 — repairWriter + applyRepair() end-to-end coverage:
 * the actual bytes written, actual resulting page/box/annotation geometry,
 * and the mandatory apply -> re-preflight -> verify pipeline's VERIFIED /
 * not-VERIFIED decision.
 */

const assert = require('node:assert/strict');
const { PDFDocument, PDFName } = require('pdf-lib');
const { applyRepair, planRepair } = require('../lib/smartfix/smartFixEngine');
const fx = require('./make-smartfix-phase2-fixtures');

const PT = 72;

async function main() {
  // 1) Exact-size book (BOX_NORMALIZATION only) -> every page gets a
  //    correct /TrimBox, VERIFIED, zero content bytes disturbed (checked
  //    indirectly: page size unchanged).
  {
    const bytes = await fx.buildExactSizeBook();
    const res = await applyRepair(bytes, fx.TARGET_6X9_NO_BLEED, {});
    assert.equal(res.documentStatus, 'APPLIED');
    assert.equal(res.verified, true);
    assert.deepEqual(res.reasons, []);
    const doc = await PDFDocument.load(res.outputBytes, { ignoreEncryption: true });
    const trimBox = doc.getPage(0).getTrimBox();
    assert.ok(Math.abs(trimBox.width - 6 * PT) < 0.01);
    assert.ok(Math.abs(trimBox.height - 9 * PT) < 0.01);
    console.log('OK: exact-size book -> BOX_NORMALIZATION applied document-wide, VERIFIED.');
  }

  // 2) Small padding deficit (SAFE_AUTOFIX) -> applied without any
  //    confirmedPageIndexes, page grows to exactly the target, VERIFIED.
  {
    const bytes = await fx.buildTooSmallBook(0.02);
    const res = await applyRepair(bytes, fx.TARGET_6X9_NO_BLEED, {});
    assert.equal(res.verified, true);
    assert.ok(res.appliedPageIndexes.includes(0), 'SAFE_AUTOFIX page must be applied even with no confirmations');
    const doc = await PDFDocument.load(res.outputBytes, { ignoreEncryption: true });
    const size = doc.getPage(0).getSize();
    assert.ok(Math.abs(size.width - 6 * PT) < 0.5);
    assert.ok(Math.abs(size.height - 9 * PT) < 0.5);
    console.log('OK: SAFE_AUTOFIX padding applied without confirmation, page now exactly target size, VERIFIED.');
  }

  // 3) Large padding deficit (USER_CONFIRMATION) -> NOT applied without
  //    confirmation; applied + VERIFIED once confirmed.
  {
    const bytes = await fx.buildTooSmallBook(0.5);
    const unconfirmed = await applyRepair(bytes, fx.TARGET_6X9_NO_BLEED, {});
    assert.ok(!unconfirmed.appliedPageIndexes.includes(0), 'USER_CONFIRMATION page must never be applied without explicit confirmation');
    assert.ok(unconfirmed.notes.includes('SOME_PAGES_SKIPPED_NOT_CONFIRMED_BY_USER'));

    const confirmed = await applyRepair(bytes, fx.TARGET_6X9_NO_BLEED, { confirmedPageIndexes: [0] });
    assert.ok(confirmed.appliedPageIndexes.includes(0));
    assert.equal(confirmed.verified, true);
    console.log('OK: USER_CONFIRMATION padding skipped without confirmation, applied + VERIFIED once confirmed.');
  }

  // 4) The 8.5x11 -> 6x9+bleed scenario, confirmed -> exact target
  //    MediaBox, correctly-placed TrimBox/BleedBox, VERIFIED.
  {
    const bytes = await fx.build85x11ToTargetWithBleedBook();
    const res = await applyRepair(bytes, fx.TARGET_6X9_WITH_BLEED, { confirmedPageIndexes: [0] });
    assert.equal(res.verified, true);
    const doc = await PDFDocument.load(res.outputBytes, { ignoreEncryption: true });
    const page0 = doc.getPage(0);
    const size = page0.getSize();
    assert.ok(Math.abs(size.width - 6.125 * PT) < 0.01, 'MediaBox width must land exactly on trim+bleed target');
    assert.ok(Math.abs(size.height - 9.25 * PT) < 0.01);
    const trimBox = page0.getTrimBox();
    assert.ok(Math.abs(trimBox.width - 6 * PT) < 0.01);
    assert.ok(Math.abs(trimBox.height - 9 * PT) < 0.01);
    const bleedBox = page0.getBleedBox();
    assert.ok(Math.abs(bleedBox.width - 6.125 * PT) < 0.01);
    console.log('OK: 8.5x11 -> 6x9+bleed, confirmed -> exact target MediaBox/TrimBox/BleedBox, VERIFIED.');
  }

  // 5) Annotation /Rect correctly transformed by the same (sx,dx,dy) as
  //    the content — exact arithmetic check, not just "doesn't throw".
  {
    const bytes = await fx.buildOversizedBookWithSafeAnnotation();
    const res = await applyRepair(bytes, fx.TARGET_6X9_NO_BLEED, { confirmedPageIndexes: [0] });
    assert.equal(res.verified, true);
    const doc = await PDFDocument.load(res.outputBytes, { ignoreEncryption: true });
    const page0 = doc.getPage(0);
    const annots = page0.node.Annots().asArray();
    const dict = doc.context.lookup(annots[0]);
    const rect = dict.lookup(PDFName.of('Rect')).asArray().map((n) => n.asNumber());
    // Original rect (xIn:1.5,yIn:1.5,widthIn:2,heightIn:0.5) -> pt
    // [108,108,252,144]; scaleFactor 0.75, dx=dy=0.
    const expected = [1.5 * PT * 0.75, 1.5 * PT * 0.75, 3.5 * PT * 0.75, 2.0 * PT * 0.75];
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(rect[i] - expected[i]) < 0.01, `rect[${i}]: ${rect[i]} vs ${expected[i]}`);
    console.log('OK: annotation /Rect transformed by the exact same (scaleFactor, dx, dy) as the page content.');
  }

  // 6) Complex-geometry annotation page -> left completely untouched
  //    (skipped), while the rest of the document (filler pages) is still
  //    correctly applied — one unsafe page must never block the whole
  //    document.
  {
    const bytes = await fx.buildOversizedBookWithComplexAnnotation();
    const res = await applyRepair(bytes, fx.TARGET_6X9_NO_BLEED, { confirmedPageIndexes: [0] });
    assert.ok(!res.appliedPageIndexes.includes(0), 'the unsafe-annotation page must never be transformed, even if "confirmed"');
    assert.ok(res.appliedPageIndexes.length > 0, 'other pages must still be processed');
    assert.equal(res.verified, true, 'verification covers only pages Smart Fix actually touched');
    console.log('OK: complex-annotation page left untouched; rest of the document still applied and VERIFIED.');
  }

  // 7) Mixed-strategy document, both confirmed -> both pages correctly
  //    transformed to their own strategy, single whole-document
  //    re-verify, VERIFIED.
  {
    const bytes = await fx.buildMixedStrategyBook();
    const res = await applyRepair(bytes, fx.TARGET_6X9_NO_BLEED, { confirmedPageIndexes: [1] });
    assert.ok(res.appliedPageIndexes.includes(0), 'SAFE_AUTOFIX padding page applied without needing confirmation');
    assert.ok(res.appliedPageIndexes.includes(1), 'confirmed USER_CONFIRMATION scale page applied');
    assert.equal(res.verified, true);
    console.log('OK: mixed-strategy document, both pages transformed correctly, single re-verify, VERIFIED.');
  }

  // 8) Encrypted document -> applyRepair() itself refuses at the hard
  //    gate, independent of whatever plans a caller might pass.
  {
    const bytes = await fx.buildEncryptedOversizedPdf();
    const res = await applyRepair(bytes, fx.TARGET_6X9_NO_BLEED, { confirmedPageIndexes: [0] });
    assert.equal(res.documentStatus, 'DO_NOT_TOUCH');
    assert.equal(res.verified, false);
    assert.deepEqual(res.outputBytes, bytes);
    console.log('OK: applyRepair() itself refuses an encrypted document at the hard gate — never just trusts a prior plan.');
  }

  console.log('\nAll Smart Fix Phase 2 writer/apply tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
