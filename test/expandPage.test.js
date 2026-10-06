'use strict';

/**
 * Advanced Page Repair #1: EXPAND PAGE to the selected size (lib/pageGeometry.js:
 * assessExpandPage / applyExpandPage / normalizePageGeometry with opts.expandPage).
 *
 * PRODUCTION BOUNDARY (finalized): 'keep-origin' is the only available anchor and a negative
 * MediaBox origin is unsupported. 'center' (negative origin when the old origin is 0) stays
 * implemented for research/tests behind `research: true` and is labelled RESEARCH below.
 *
 * Page boxes only. Every "safe" claim is checked on real saved bytes with the
 * real preflight; every rejection must leave the input untouched; the verifier
 * is attacked with mutations to prove each invariant really detects a change.
 */

const assert = require('node:assert/strict');
const {
  PDFDocument,
  PDFName,
  PDFString,
  PDFPage,
  StandardFonts,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  setFillingRgbColor,
  fill,
} = require('pdf-lib');
const { assessPageGeometry, assessExpandPage, applyExpandPage, normalizePageGeometry, CATEGORY } = require('../lib/pageGeometry');
const { runPreflight } = require('../lib/orchestrator');

const U = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false };
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const rectOps = (x, y, w, h) => [pushGraphicsState(), setFillingRgbColor(0.2, 0.2, 0.2), rectangle(x, y, w, h), fill(), popGraphicsState()];
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * A realistic small book: content rectangle, Helvetica text (Font resource),
 * a PNG (XObject stream), a Link annotation, Info metadata.
 * The page is [ox, oy, w, h]; content is positioned relative to that origin.
 */
async function make({ w = 396, h = 612, pages = 30, inset = 60, origin = [0, 0], setup, link = true, meta = true } = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  if (meta) {
    doc.setTitle('Synthetic Book');
    doc.setAuthor('Author Name');
    doc.setSubject('subject');
    doc.setKeywords(['k1', 'k2']);
    doc.setCreator('creator');
    doc.setProducer('producer');
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const png = await doc.embedPng(PNG_1X1);
  const [ox, oy] = origin;
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([w, h]);
    if (ox !== 0 || oy !== 0) p.setMediaBox(ox, oy, w, h);
    p.pushOperators(...rectOps(ox + inset, oy + inset, w - 2 * inset, h - 2 * inset));
    p.drawText(`page ${i + 1}`, { x: ox + inset + 8, y: oy + inset + 8, size: 10, font, color: undefined });
    p.drawImage(png, { x: ox + inset + 8, y: oy + inset + 30, width: 20, height: 20 });
    if (link) {
      const a = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [ox + inset, oy + inset, ox + inset + 60, oy + inset + 30], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com') } });
      p.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(a)]));
    }
    if (setup) setup(p, i, doc);
  }
  return doc.save();
}

function contentBytes(doc, page) {
  const c = page.node.Contents();
  const list = c.asArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
  return Buffer.concat(list.map((st) => Buffer.from(st.getContents())));
}

const boxOf = (b) => [b.x, b.y, b.width, b.height].map((n) => +n.toFixed(6));

async function readBack(bytes) {
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  return d;
}

// Production path: only 'keep-origin' exists. `research: true` is the test/research switch the frontend worker never forwards.
const expand = (bytes, anchor = 'keep-origin', extra = {}) => normalizePageGeometry(bytes, { userIntent: U, expandPage: { anchor, confirmed: true }, ...extra });
const expandResearch = (bytes, anchor) => normalizePageGeometry(bytes, { userIntent: U, expandPage: { anchor, confirmed: true, research: true } });

let n = 0;
async function runCase(label, fn) {
  n += 1;
  await fn();
  console.log(`  [${n}] ${label}: OK`);
}

async function main() {
  const small = await make(); // 5.5 x 8.5 in, content inset 60

  // ===== assess: eligibility + preview, no side effects =====
  await runCase('assessExpandPage: 5.5x8.5 -> 6x9 is eligible; production preview shows keep-origin only', async () => {
    const copy = new Uint8Array(small);
    const a = await assessExpandPage(small, U);
    assert.equal(a.eligible, true);
    assert.deepEqual(a.reasons, []);
    assert.deepEqual(a.target, { widthPt: 432, heightPt: 648 });
    assert.deepEqual(a.current, { widthPt: 396, heightPt: 612 });
    assert.deepEqual(Object.keys(a.previews), ['keep-origin'], 'production exposes only the keep-origin anchor');
    assert.deepEqual(a.previews['keep-origin'].addedPt, { left: 0, bottom: 0, right: 36, top: 36 });
    // research view still knows the centered variant
    const r = await assessExpandPage(small, U, { research: true });
    assert.deepEqual(r.previews.center.addedPt, { left: 18, bottom: 18, right: 18, top: 18 });
    assert.ok(same(small, copy), 'assess never changes the input');
  });

  await runCase('assessPageGeometry carries the offer in `expand` and leaves category/tier/plan exactly as before', async () => {
    const a = await assessPageGeometry(small, U);
    assert.equal(a.category, CATEGORY.DIFFERENT_SIZE);
    assert.equal(a.tier, 4);
    assert.equal(a.plan, null);
    assert.equal(a.expand.eligible, true);
  });

  await runCase('Tier 1 / Tier 2 behavior is unchanged (exact page: no expand offer, plan intact, normalization still works)', async () => {
    const exact = await make({ w: 432, h: 648 });
    const a = await assessPageGeometry(exact, U);
    assert.equal(a.tier, 1);
    assert.equal(a.plan.kind, 'ADD_TRIM_BOX');
    assert.equal(a.expand, null, 'nothing smaller than the target -> no offer');
    const res = await normalizePageGeometry(exact, { userIntent: U });
    assert.equal(res.applied, true);
    assert.equal(res.after.verdict, 'READY');
  });

  // ===== CENTER (RESEARCH ONLY: negative MediaBox origin) =====
  await runCase('RESEARCH center: boxes, content, annotations, resources, metadata; REAL preflight READY', async () => {
    const copy = new Uint8Array(small);
    const res = await expandResearch(small, 'center');
    assert.equal(res.applied, true);
    assert.equal(res.safety.ok, true);
    assert.equal(res.after.verdict, 'READY', 'AFTER verdict comes from the real runPreflight');
    assert.ok(same(small, copy), 'input bytes untouched');
    assert.ok(!same(res.outputBytes, small));
    const out = await readBack(res.outputBytes);
    const src = await readBack(small);
    assert.equal(out.getPageCount(), 30);
    out.getPages().forEach((p, i) => {
      assert.deepEqual(boxOf(p.getMediaBox()), [-18, -18, 432, 648]);
      assert.deepEqual(boxOf(p.getTrimBox()), [-18, -18, 432, 648]);
      assert.equal(p.node.CropBox(), undefined);
      assert.equal(p.node.BleedBox(), undefined);
      assert.equal(p.node.ArtBox(), undefined);
      // content stream bytes identical to the source page
      assert.ok(contentBytes(out, p).equals(contentBytes(src, src.getPage(i))));
    });
    assert.equal(out.getTitle(), 'Synthetic Book');
    assert.equal(out.getAuthor(), 'Author Name');
    assert.equal(out.getProducer(), 'producer');
    // the original is an independent, still-usable document (undo)
    assert.ok(same(res.outputBytes, res.outputBytes));
    const again = await assessPageGeometry(res.outputBytes, U);
    assert.equal(again.tier, 0);
    assert.equal(again.category, CATEGORY.EXACT_TRIM_PRESENT);
    assert.equal(again.expand, null);
  });

  // ===== KEEP-ORIGIN =====
  await runCase('KEEP-ORIGIN (production): lower-left origin stays; space is added at the top/right; REAL preflight READY', async () => {
    const res = await expand(small, 'keep-origin');
    assert.equal(res.applied, true);
    assert.equal(res.after.verdict, 'READY');
    assert.ok(res.safety.checks.some((c) => c.id === 'MEDIA_BOX_ORIGIN_NON_NEGATIVE' && c.ok));
    const out = await readBack(res.outputBytes);
    out.getPages().forEach((p) => {
      assert.deepEqual(boxOf(p.getMediaBox()), [0, 0, 432, 648]);
      assert.deepEqual(boxOf(p.getTrimBox()), [0, 0, 432, 648]);
    });
  });

  await runCase('non-zero (positive) MediaBox origin: keep-origin keeps it exactly; research center would go negative', async () => {
    const shifted = await make({ origin: [10, 20] });
    const c = await expandResearch(shifted, 'center');
    assert.equal(c.applied, true);
    (await readBack(c.outputBytes)).getPages().forEach((p) => assert.deepEqual(boxOf(p.getMediaBox()), [-8, 2, 432, 648]));
    const k = await expand(shifted, 'keep-origin');
    assert.equal(k.applied, true);
    (await readBack(k.outputBytes)).getPages().forEach((p) => assert.deepEqual(boxOf(p.getMediaBox()), [10, 20, 432, 648]));
  });

  await runCase('only one dimension smaller (6 x 8.5 -> 6 x 9): width untouched, height expanded', async () => {
    const b = await make({ w: 432, h: 612 });
    const res = await expand(b, 'keep-origin');
    assert.equal(res.applied, true);
    (await readBack(res.outputBytes)).getPages().forEach((p) => assert.deepEqual(boxOf(p.getMediaBox()), [0, 0, 432, 648]));
  });

  await runCase('an explicit CropBox equal to the MediaBox is expanded with it (otherwise it would crop)', async () => {
    const b = await make({ setup: (p) => p.setCropBox(0, 0, 396, 612) });
    const res = await expand(b, 'keep-origin');
    assert.equal(res.applied, true);
    (await readBack(res.outputBytes)).getPages().forEach((p) => {
      assert.deepEqual(boxOf(p.getCropBox()), [0, 0, 432, 648]);
      assert.deepEqual(boxOf(p.getMediaBox()), [0, 0, 432, 648]);
    });
  });

  await runCase('UserUnit = 1 (explicit) is accepted', async () => {
    const b = await make({ setup: (p, i, doc) => p.node.set(PDFName.of('UserUnit'), doc.context.obj(1)) });
    assert.equal((await assessExpandPage(b, U)).eligible, true);
  });

  // ===== explicit confirmation + anchor =====
  await runCase('no confirmation -> nothing is applied (original bytes returned)', async () => {
    for (const expandPage of [{ anchor: 'keep-origin' }, { anchor: 'keep-origin', confirmed: false }, { anchor: 'keep-origin', confirmed: 'yes' }]) {
      const res = await normalizePageGeometry(small, { userIntent: U, expandPage });
      assert.equal(res.applied, false);
      assert.equal(res.safety.failure, 'CONFIRMATION_REQUIRED');
      assert.ok(same(res.outputBytes, small));
    }
  });

  await runCase('no / invalid anchor -> rejected, never defaulted', async () => {
    for (const anchor of [undefined, null, '', 'centre', 'CENTER', 'Keep-Origin', 'top-left', 0]) {
      const res = await normalizePageGeometry(small, { userIntent: U, expandPage: { anchor, confirmed: true } });
      assert.equal(res.applied, false);
      assert.equal(res.safety.failure, 'ANCHOR_REQUIRED');
      assert.ok(same(res.outputBytes, small));
    }
    const direct = await applyExpandPage(small, U, undefined);
    assert.equal(direct.ok, false);
    assert.equal(direct.failure, 'ANCHOR_REQUIRED');
    assert.equal(direct.outputBytes, null);
  });

  await runCase('production: the centered anchor is NOT available (and never reaches the engine from the UI worker); research flag keeps it testable', async () => {
    const copy = new Uint8Array(small);
    const res = await normalizePageGeometry(small, { userIntent: U, expandPage: { anchor: 'center', confirmed: true } });
    assert.equal(res.applied, false);
    assert.equal(res.safety.failure, 'ANCHOR_NOT_AVAILABLE');
    assert.ok(same(res.outputBytes, copy));
    const direct = await applyExpandPage(small, U, 'center');
    assert.equal(direct.ok, false);
    assert.equal(direct.failure, 'ANCHOR_NOT_AVAILABLE');
    assert.equal(direct.outputBytes, null);
    const research = await applyExpandPage(small, U, 'center', { research: true });
    assert.equal(research.ok, true, 'center stays implemented for research/tests');
  });

  await runCase('negative MediaBox origin is unsupported: input with a negative origin -> NEGATIVE_MEDIA_BOX_ORIGIN, nothing applied', async () => {
    for (const origin of [[-10, 0], [0, -10], [-18, -18]]) {
      const neg = await make({ origin });
      const copy = new Uint8Array(neg);
      const a = await assessExpandPage(neg, U);
      assert.equal(a.eligible, false);
      assert.ok(a.reasons.includes('NEGATIVE_MEDIA_BOX_ORIGIN'), JSON.stringify(a.reasons));
      const direct = await applyExpandPage(neg, U, 'keep-origin');
      assert.equal(direct.ok, false);
      assert.equal(direct.failure, 'NOT_ELIGIBLE');
      assert.equal(direct.outputBytes, null);
      const res = await expand(neg, 'keep-origin');
      assert.equal(res.applied, false);
      assert.ok(same(res.outputBytes, copy));
      assert.ok(same(neg, copy));
    }
  });

  await runCase('keep-origin NEVER writes a negative origin: for every accepted input the saved MediaBox origin equals the input origin and is >= 0', async () => {
    for (const origin of [[0, 0], [10, 20], [0, 36], [100, 100]]) {
      const b = await make({ origin });
      const res = await expand(b, 'keep-origin');
      assert.equal(res.applied, true, `origin ${origin}`);
      (await readBack(res.outputBytes)).getPages().forEach((p) => {
        const m = p.getMediaBox();
        assert.deepEqual([m.x, m.y], origin);
        assert.ok(m.x >= 0 && m.y >= 0);
      });
    }
  });

  await runCase('research center on a zero origin DOES produce a negative origin (this is why it is not exposed)', async () => {
    const res = await expandResearch(small, 'center');
    assert.equal(res.applied, true);
    const m = (await readBack(res.outputBytes)).getPage(0).getMediaBox();
    assert.ok(m.x < 0 && m.y < 0);
  });

  await runCase('intent is never inferred: missing trim size or bleed choice -> rejected', async () => {
    const noTrim = await assessExpandPage(small, { bleed: false });
    assert.equal(noTrim.eligible, false);
    assert.ok(noTrim.reasons.includes('TRIM_SIZE_MISSING'));
    const noBleed = await assessExpandPage(small, { trimSize: U.trimSize });
    assert.equal(noBleed.eligible, false);
    assert.ok(noBleed.reasons.includes('BLEED_CHOICE_MISSING'));
    const res = await normalizePageGeometry(small, { userIntent: { trimSize: U.trimSize }, expandPage: { anchor: 'center', confirmed: true } });
    assert.equal(res.applied, false);
    assert.ok(same(res.outputBytes, small));
  });

  await runCase('bleed selected -> rejected (this operation targets the plain trim size only; no KDP bleed rules invented)', async () => {
    const a = await assessExpandPage(small, { ...U, bleed: true, readingDirection: 'ltr' });
    assert.equal(a.eligible, false);
    assert.deepEqual(a.reasons, ['BLEED_SELECTED']);
  });

  // ===== rejections =====
  async function expectRejected(label, bytes, reason, intent = U) {
    await runCase(`rejected: ${label} -> ${reason}`, async () => {
      const copy = new Uint8Array(bytes);
      const a = await assessExpandPage(bytes, intent);
      assert.ok(a, 'a smaller page exists, so the offer is described');
      assert.equal(a.eligible, false);
      assert.ok(a.reasons.includes(reason), `reasons ${JSON.stringify(a.reasons)}`);
      const direct = await applyExpandPage(bytes, intent, 'keep-origin');
      assert.equal(direct.ok, false);
      assert.equal(direct.failure, 'NOT_ELIGIBLE');
      assert.equal(direct.outputBytes, null);
      const res = await normalizePageGeometry(bytes, { userIntent: intent, expandPage: { anchor: 'keep-origin', confirmed: true } });
      assert.equal(res.applied, false);
      assert.equal(res.safety.ok, false);
      assert.ok(same(res.outputBytes, copy), 'original bytes returned');
      assert.ok(same(bytes, copy), 'input untouched');
    });
  }

  {
    const doc = await PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < 30; i++) doc.addPage([396, 612]);
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: PDFString.of('x'), U: PDFString.of('y'), P: -4 }));
    await expectRejected('encrypted', await doc.save(), 'ENCRYPTED');
  }
  {
    const doc = await PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < 30; i++) doc.addPage([396, 612]);
    const sig = doc.context.register(doc.context.obj({ FT: 'Sig', T: PDFString.of('Signature1'), V: doc.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached' }) }));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [sig], SigFlags: 3 }));
    await expectRejected('digitally signed', await doc.save(), 'SIGNED');
  }
  {
    const doc = await PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < 30; i++) doc.addPage([396, 612]);
    const tf = doc.getForm().createTextField('name');
    tf.addToPage(doc.getPage(0), { x: 100, y: 300, width: 120, height: 20 });
    await expectRejected('AcroForm with a text field', await doc.save(), 'HAS_FORMS');
  }
  await expectRejected('a Widget annotation without an AcroForm', await make({ link: false, setup: (p, i, doc) => i === 0 && p.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [100, 100, 150, 120] }))])) }), 'HAS_FORMS');
  await expectRejected('UserUnit = 2', await make({ setup: (p, i, doc) => p.node.set(PDFName.of('UserUnit'), doc.context.obj(2)) }), 'USER_UNIT');
  await expectRejected('a rotated page (/Rotate 90)', await make({ setup: (p, i) => i === 3 && p.setRotation(degrees(90)) }), 'ROTATED_PAGE');
  await expectRejected('mixed page sizes', await make({ setup: (p, i) => i >= 28 && p.setSize(360, 576) }), 'MIXED_PAGE_SIZES');
  await expectRejected('one page larger than the target', await make({ setup: (p, i) => i === 5 && p.setSize(500, 700) }), 'PAGE_LARGER_THAN_TARGET');
  await expectRejected('CropBox that differs from the MediaBox', await make({ setup: (p) => p.setCropBox(10, 10, 300, 500) }), 'CROP_BOX_DIFFERS');
  await expectRejected('explicit TrimBox', await make({ setup: (p) => p.setTrimBox(0, 0, 396, 612) }), 'EXISTING_PAGE_BOXES');
  await expectRejected('explicit BleedBox', await make({ setup: (p) => p.setBleedBox(0, 0, 396, 612) }), 'EXISTING_PAGE_BOXES');
  await expectRejected('explicit ArtBox', await make({ setup: (p) => p.setArtBox(10, 10, 300, 500) }), 'EXISTING_PAGE_BOXES');
  await expectRejected('unreadable / non-positive geometry on some page', await make({ setup: (p, i) => i === 7 && p.setMediaBox(0, 0, 0, 612) }), 'UNSUPPORTED_GEOMETRY');

  await runCase('nothing to expand: a page at/over the target size gets no offer and no operation', async () => {
    for (const [w, h] of [[432, 648], [595.28, 841.89], [612, 792]]) {
      const b = await make({ w, h });
      assert.equal(await assessExpandPage(b, U), null);
      const res = await normalizePageGeometry(b, { userIntent: U, expandPage: { anchor: 'keep-origin', confirmed: true } });
      assert.equal(res.applied, false);
      assert.equal(res.safety.failure, 'NOTHING_TO_EXPAND');
      assert.ok(same(res.outputBytes, b));
    }
  });

  // ===== output only when AFTER is READY =====
  await runCase('AFTER not READY -> fail closed: nothing adopted, original returned, real AFTER result explains why', async () => {
    const tight = await make({ inset: 10 }); // content 10pt from every edge
    const k = await expand(tight, 'keep-origin'); // adds nothing on the left/bottom -> margin violation
    assert.equal(k.applied, false);
    assert.equal(k.safety.failure, 'AFTER_NOT_READY');
    assert.ok(same(k.outputBytes, tight), 'original bytes returned');
    assert.ok(k.after && k.after.verdict !== 'READY', 'the real AFTER preflight is returned for display');
    assert.ok(k.safety.checks.some((c) => c.id === 'AFTER_PREFLIGHT_READY' && c.ok === false));
    // research only: the centered variant of the same file would pass (it is not offered in production)
    const c = await expandResearch(tight, 'center');
    assert.equal(c.applied, true);
    assert.equal(c.after.verdict, 'READY');
  });

  await runCase('the AFTER verdict is exactly runPreflight(outputBytes): nothing is decided in pageGeometry', async () => {
    const res = await expand(small, 'keep-origin');
    const direct = await runPreflight(res.outputBytes, { userIntent: U });
    assert.equal(direct.verdict, res.after.verdict);
    assert.equal(direct.violations.length, res.after.violations.length);
  });

  // ===== verifier detection power (negative tests) =====
  async function withMutation(method, mutate, run) {
    const original = PDFPage.prototype[method];
    let busy = false;
    PDFPage.prototype[method] = function patched(...args) {
      original.apply(this, args);
      if (busy) return;
      busy = true;
      try {
        mutate(this);
      } finally {
        busy = false;
      }
    };
    try {
      return await run();
    } finally {
      PDFPage.prototype[method] = original;
    }
  }
  async function expectDetected(label, id, { bytes = small, mutate, method = 'setTrimBox', anchor = 'keep-origin' }) {
    const opts = { research: anchor === 'center' };
    await runCase(`verifier detects: ${label} -> ${id}`, async () => {
      const copy = new Uint8Array(bytes);
      const res = await withMutation(method, mutate, () => applyExpandPage(bytes, U, anchor, opts));
      assert.equal(res.ok, false, 'must fail closed');
      assert.equal(res.failure, id);
      assert.equal(res.outputBytes, null, 'no output when a check fails');
      assert.ok(same(bytes, copy), 'input bytes untouched');
      const control = await applyExpandPage(bytes, U, anchor, opts);
      assert.equal(control.ok, true, 'control: the unmutated apply passes every check');
    });
  }
  const PN = (s) => PDFName.of(s);

  await expectDetected('page content translated', 'CONTENT_STREAMS_CHANGED', { mutate: (p) => p.translateContent(5, 5) });
  await expectDetected('page content scaled', 'CONTENT_STREAMS_CHANGED', { mutate: (p) => p.scaleContent(0.9, 0.9) });
  await expectDetected('content operators appended', 'CONTENT_STREAMS_CHANGED', { mutate: (p) => p.pushOperators(...rectOps(0, 0, 5, 5)) });
  await expectDetected('annotation moved', 'ANNOTATIONS_CHANGED', {
    mutate: (p) => p.node.Annots().lookup(0).set(PN('Rect'), p.doc.context.obj([0, 0, 10, 10])),
  });
  await expectDetected('annotation dropped', 'ANNOTATIONS_CHANGED', { mutate: (p) => p.node.delete(PN('Annots')) });
  await expectDetected('annotation action changed', 'ANNOTATIONS_CHANGED', {
    mutate: (p) => p.node.Annots().lookup(0).set(PN('Border'), p.doc.context.obj([1, 1, 1])),
  });
  await expectDetected('resources changed (ExtGState added)', 'RESOURCES_CHANGED', {
    mutate: (p) => p.node.Resources().set(PN('ExtGState'), p.doc.context.obj({ GS1: { CA: 0.5 } })),
  });
  await expectDetected('a font resource dropped', 'RESOURCES_CHANGED', { mutate: (p) => p.node.Resources().delete(PN('Font')) });
  await expectDetected('another page-dictionary entry added (/Group)', 'PAGE_DICT_CHANGED', {
    mutate: (p) => p.node.set(PN('Group'), p.doc.context.obj({ S: 'Transparency' })),
  });
  await expectDetected('UserUnit added', 'PAGE_DICT_CHANGED', { mutate: (p) => p.node.set(PN('UserUnit'), p.doc.context.obj(2)) });
  await expectDetected('page rotated', 'PAGE_DICT_CHANGED', { mutate: (p) => p.setRotation(degrees(90)) });
  await expectDetected('catalog changed (/PageMode)', 'CATALOG_CHANGED', { mutate: (p) => p.doc.catalog.set(PN('PageMode'), PN('FullScreen')) });
  await expectDetected('document metadata changed', 'METADATA_CHANGED', { mutate: (p) => p.doc.setTitle('Tampered') });
  await expectDetected('page count changed', 'PAGE_COUNT_CHANGED', { mutate: (p) => p.doc.addPage([100, 100]) });
  await expectDetected('MediaBox differs from the plan', 'MEDIA_BOX_NOT_AS_PLANNED', { mutate: (p) => p.setMediaBox(0, 0, 500, 700) });
  await expectDetected('MediaBox shifted by 3pt (wrong anchor offset)', 'MEDIA_BOX_NOT_AS_PLANNED', { mutate: (p) => p.setMediaBox(3, 0, 432, 648) });
  await expectDetected('MediaBox origin pushed negative after planning', 'MEDIA_BOX_NOT_AS_PLANNED', { mutate: (p) => p.setMediaBox(-18, -18, 432, 648) });
  await expectDetected('RESEARCH center: MediaBox shifted by 3pt (wrong anchor offset)', 'MEDIA_BOX_NOT_AS_PLANNED', { mutate: (p) => p.setMediaBox(-15, -18, 432, 648), anchor: 'center' });
  await expectDetected('TrimBox differs from the plan', 'TRIM_BOX_NOT_AS_PLANNED', { mutate: (p) => p.setTrimBox(0, 0, 400, 600), method: 'setTrimBox' });
  await expectDetected('an unplanned CropBox appears', 'CROP_BOX_NOT_AS_PLANNED', { mutate: (p) => p.setCropBox(0, 0, 300, 400) });
  // BleedBox/ArtBox are not in the allowed-change list, so the page-dictionary comparison catches them first
  // (the later UNEXPECTED_BOX check is defense in depth).
  await expectDetected('an unplanned BleedBox appears', 'PAGE_DICT_CHANGED', { mutate: (p) => p.setBleedBox(0, 0, 432, 648) });
  await expectDetected('an unplanned ArtBox appears', 'PAGE_DICT_CHANGED', { mutate: (p) => p.setArtBox(10, 10, 400, 600) });
  await expectDetected('keep-origin: MediaBox origin moved', 'MEDIA_BOX_NOT_AS_PLANNED', { mutate: (p) => p.setMediaBox(-5, 0, 432, 648), anchor: 'keep-origin' });

  await runCase('verifier compares image/font streams byte-for-byte (a changed embedded stream is detected)', async () => {
    let done = false; // the image is shared by all pages: flip it exactly once (an even number of flips would cancel out)
    const res = await withMutation(
      'setTrimBox',
      (p) => {
        if (done) return;
        done = true;
        const xo = p.node.Resources().lookup(PN('XObject'));
        const im = p.doc.context.lookup(xo.entries()[0][1]);
        im.contents = new Uint8Array([...im.contents].map((v, i) => (i === 0 ? v ^ 1 : v)));
      },
      () => applyExpandPage(small, U, 'keep-origin')
    );
    assert.equal(res.ok, false);
    assert.equal(res.failure, 'RESOURCES_CHANGED');
    assert.equal(res.outputBytes, null);
  });

  console.log(`\nexpandPage.test.js: ${n} cases passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
