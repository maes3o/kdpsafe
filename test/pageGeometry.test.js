'use strict';

/**
 * Page-geometry V2: assessment tiers, metadata-only normalization and its
 * safety guarantees (lib/pageGeometry.js). Every "safe" claim is checked on
 * real saved bytes; every "manual" scenario must leave the input untouched.
 *
 * Scenario letters follow the V2 task (A..R); R (frontend) lives in
 * frontend/src/App.test.tsx.
 */

const assert = require('node:assert/strict');
const {
  PDFDocument,
  PDFName,
  PDFString,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  setFillingRgbColor,
  fill,
} = require('pdf-lib');
const { assessPageGeometry, applyNormalization, normalizePageGeometry, CATEGORY } = require('../lib/pageGeometry');

const rect = (x, y, w, h) => [pushGraphicsState(), setFillingRgbColor(0.2, 0.2, 0.2), rectangle(x, y, w, h), fill(), popGraphicsState()];
const U_NOBLEED = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false };
const U_BLEED_LTR = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true, readingDirection: 'ltr' };
const U_BLEED_RTL = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true, readingDirection: 'rtl' };
const U_BLEED_NODIR = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true };

async function make({ w, h, pages = 30, perPage, rects = [[100, 200, 100, 100]], setup, meta, annots }) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  if (meta) {
    doc.setTitle(meta.title);
    doc.setAuthor(meta.author);
    doc.setSubject('subj');
    doc.setKeywords(['a', 'b']);
  }
  for (let i = 0; i < pages; i++) {
    const [pw, ph] = perPage ? perPage(i) : [w, h];
    const p = doc.addPage([pw, ph]);
    if (i === 0) for (const r of rects) p.pushOperators(...rect(...r));
    if (setup) setup(p, i, doc);
    if (annots && i === 0) {
      const link = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [100, 100, 160, 130], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com') } });
      p.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link)]));
    }
  }
  return doc.save();
}

let n = 0;
async function runCase(label, fn) {
  n += 1;
  await fn();
  console.log(`  [${n}] ${label}: OK`);
}

function contentBytes(doc, page) {
  const c = page.node.Contents();
  if (!c) return Buffer.alloc(0);
  const list = c.asArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
  return Buffer.concat(list.map((st) => Buffer.from(st.getContents())));
}
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

async function main() {
  // ===== A. page == selected trim, no TrimBox -> Tier 1 plan =====
  await runCase('A. page == trim, no TrimBox -> tier 1 ADD_TRIM_BOX plan (30 pages)', async () => {
    const bytes = await make({ w: 432, h: 648 });
    const a = await assessPageGeometry(bytes, U_NOBLEED);
    assert.equal(a.category, CATEGORY.EXACT_PAGE_NO_TRIM);
    assert.equal(a.tier, 1);
    assert.equal(a.trimBox, 'missing');
    assert.equal(a.plan.kind, 'ADD_TRIM_BOX');
    assert.equal(a.plan.changes.length, 30);
    assert.deepEqual(a.plan.changes[0].set.trimBox, { x: 0, y: 0, width: 432, height: 648 });
    assert.deepEqual(a.plan.guarantees, { contentStreamsUnchanged: true, scales: false, crops: false, moves: false, rotates: false });
  });

  // ===== P/O. apply -> AFTER real preflight, content bytes identical =====
  await runCase('A/O/P. apply: content streams byte-identical, AFTER preflight is the real engine result', async () => {
    const bytes = await make({ w: 432, h: 648 });
    const before = await require('../lib/orchestrator').runPreflight(bytes, { userIntent: U_NOBLEED });
    assert.equal(before.verdict, 'MANUAL_REVIEW_REQUIRED', 'precondition: without TrimBox the engine cannot give a verdict');
    const res = await normalizePageGeometry(bytes, { userIntent: U_NOBLEED });
    assert.equal(res.applied, true);
    assert.ok(res.safety.ok);
    assert.ok(res.safety.checks.some((c) => c.id === 'CONTENT_STREAMS_BYTE_IDENTICAL' && c.ok));
    assert.equal(res.after.verdict, 'READY', 'the real preflight now evaluates the page');
    assert.ok(res.after.geometry.pages[0].diagnostics.some((d) => d.code === 'TRIM_BOX_ANCHOR_USED'));
    // independent re-check of the OUTPUT bytes
    const out = await PDFDocument.load(res.outputBytes);
    const orig = await PDFDocument.load(bytes);
    assert.equal(out.getPageCount(), 30);
    for (let i = 0; i < 30; i++) {
      assert.ok(same(contentBytes(out, out.getPage(i)), contentBytes(orig, orig.getPage(i))), `page ${i + 1} content`);
    }
    // input bytes object untouched
    assert.equal((await PDFDocument.load(bytes)).getPage(0).node.TrimBox(), undefined);
  });

  await runCase('P. the AFTER result can reveal real problems (normalization never fakes READY)', async () => {
    const bytes = await make({ w: 432, h: 648, rects: [[100, 300, 100, 340]] }); // 10pt over safe-zone top
    const res = await normalizePageGeometry(bytes, { userIntent: U_NOBLEED });
    assert.equal(res.applied, true);
    assert.notEqual(res.after.verdict, 'READY');
  });

  // ===== B. page == trim + bleed =====
  await runCase('B. trim+bleed page, LTR: odd page trim at left (inside), even page offset by outer bleed', async () => {
    const bytes = await make({ w: 441, h: 666 });
    const a = await assessPageGeometry(bytes, U_BLEED_LTR);
    assert.equal(a.category, CATEGORY.EXACT_PAGE_WITH_BLEED);
    assert.equal(a.tier, 2);
    assert.equal(a.plan.kind, 'DEFINE_TRIM_BOX_FROM_BLEED');
    const odd = a.plan.changes[0].set;
    const even = a.plan.changes[1].set;
    assert.deepEqual(odd.trimBox, { x: 0, y: 9, width: 432, height: 648 });
    assert.deepEqual(even.trimBox, { x: 9, y: 9, width: 432, height: 648 });
    assert.deepEqual(odd.bleedBox, { x: 0, y: 0, width: 441, height: 666 });
  });

  await runCase('B. RTL mirrors the parity', async () => {
    const bytes = await make({ w: 441, h: 666 });
    const a = await assessPageGeometry(bytes, U_BLEED_RTL);
    assert.deepEqual(a.plan.changes[0].set.trimBox, { x: 9, y: 9, width: 432, height: 648 });
    assert.deepEqual(a.plan.changes[1].set.trimBox, { x: 0, y: 9, width: 432, height: 648 });
  });

  await runCase('B. without reading direction there is NO plan (parity cannot be guessed)', async () => {
    const bytes = await make({ w: 441, h: 666 });
    const a = await assessPageGeometry(bytes, U_BLEED_NODIR);
    assert.equal(a.category, CATEGORY.EXACT_PAGE_WITH_BLEED);
    assert.equal(a.tier, 2);
    assert.equal(a.plan, null);
    assert.ok(a.reasons.includes('READING_DIRECTION_REQUIRED'));
  });

  await runCase('B. applied trim+bleed boxes -> real preflight uses the explicit anchors', async () => {
    const bytes = await make({ w: 441, h: 666 });
    const res = await normalizePageGeometry(bytes, { userIntent: U_BLEED_LTR });
    assert.equal(res.applied, true);
    const codes = res.after.geometry.pages[0].diagnostics.map((d) => d.code);
    assert.ok(codes.includes('TRIM_BOX_ANCHOR_USED') && codes.includes('BLEED_BOX_ANCHOR_USED'), codes.join());
    assert.notEqual(res.after.verdict, 'MANUAL_REVIEW_REQUIRED', 'geometry is now resolved');
  });

  await runCase('B. page count outside the KDP table range: parity unresolved -> no plan', async () => {
    const bytes = await make({ w: 441, h: 666, pages: 10 });
    const a = await assessPageGeometry(bytes, U_BLEED_LTR);
    assert.equal(a.plan, null);
    assert.ok(a.reasons.includes('BLEED_HORIZONTAL_UNRESOLVED'));
  });

  // ===== C/D. larger / different sizes =====
  await runCase('C/D. A4 page vs 6x9 (no TrimBox) -> tier 4, no plan, no modification', async () => {
    const bytes = await make({ w: 595.28, h: 841.89 });
    const a = await assessPageGeometry(bytes, U_NOBLEED);
    assert.equal(a.category, CATEGORY.DIFFERENT_SIZE);
    assert.equal(a.tier, 4);
    assert.equal(a.plan, null);
    const res = await normalizePageGeometry(bytes, { userIntent: U_NOBLEED });
    assert.equal(res.applied, false);
    assert.ok(same(res.outputBytes, bytes), 'input bytes returned unchanged');
  });

  await runCase('C. larger page with uniform margins (Letter) -> still tier 4 (no centre-crop guess)', async () => {
    const a = await assessPageGeometry(await make({ w: 612, h: 792 }), U_NOBLEED);
    assert.equal(a.tier, 4);
    assert.equal(a.plan, null);
  });

  await runCase('Tier 3. close-but-different size -> manual, never auto-resized', async () => {
    const a = await assessPageGeometry(await make({ w: 432 + 3, h: 648 + 2 }), U_NOBLEED);
    assert.equal(a.category, CATEGORY.SIMILAR_COMPATIBLE);
    assert.equal(a.tier, 3);
    assert.equal(a.plan, null);
  });

  await runCase('size/bleed intent mismatches are manual, not repaired', async () => {
    const withBleedSize = await assessPageGeometry(await make({ w: 441, h: 666 }), U_NOBLEED);
    assert.ok(withBleedSize.reasons.includes('PAGE_HAS_BLEED_SIZE_BUT_NO_BLEED_SELECTED'));
    assert.equal(withBleedSize.plan, null);
    const trimSizeButBleed = await assessPageGeometry(await make({ w: 432, h: 648 }), U_BLEED_LTR);
    assert.ok(trimSizeButBleed.reasons.includes('PAGE_IS_TRIM_SIZE_BUT_BLEED_SELECTED'));
    assert.equal(trimSizeButBleed.plan, null);
  });

  // ===== E/F. explicit boxes =====
  await runCase('E. explicit correct TrimBox -> tier 0, nothing to repair', async () => {
    const bytes = await make({ w: 432, h: 648, setup: (p) => p.setTrimBox(0, 0, 432, 648) });
    const a = await assessPageGeometry(bytes, U_NOBLEED);
    assert.equal(a.category, CATEGORY.EXACT_TRIM_PRESENT);
    assert.equal(a.tier, 0);
    assert.equal(a.plan, null);
    assert.equal(a.trimBox, 'explicit');
  });

  await runCase('E. A4 page with explicit centred 6x9 TrimBox -> tier 0 (author-defined trim is respected)', async () => {
    const bytes = await make({ w: 595.28, h: 841.89, setup: (p) => p.setTrimBox(81.64, 96.945, 432, 648) });
    const a = await assessPageGeometry(bytes, U_NOBLEED);
    assert.equal(a.tier, 0);
  });

  await runCase('F. explicit TrimBox + BleedBox -> no destructive repair', async () => {
    const bytes = await make({ w: 441, h: 666, setup: (p) => { p.setTrimBox(0, 9, 432, 648); p.setBleedBox(0, 0, 441, 666); } });
    const a = await assessPageGeometry(bytes, U_BLEED_LTR);
    assert.equal(a.tier, 0);
    assert.equal(a.plan, null);
  });

  await runCase('explicit TrimBox of the WRONG size -> conflicting, do not touch', async () => {
    const bytes = await make({ w: 595.28, h: 841.89, setup: (p) => p.setTrimBox(81.64, 96.945, 400, 600) });
    const a = await assessPageGeometry(bytes, U_NOBLEED);
    assert.equal(a.category, CATEGORY.CONFLICTING_BOXES);
    assert.equal(a.tier, 5);
    assert.ok(a.reasons.includes('TRIM_BOX_MISMATCH'));
  });

  await runCase('CropBox differing from MediaBox (no TrimBox) -> conflicting boxes, do not touch', async () => {
    const bytes = await make({ w: 612, h: 792, setup: (p) => p.setCropBox(90, 72, 432, 648) });
    const a = await assessPageGeometry(bytes, U_NOBLEED);
    assert.equal(a.category, CATEGORY.CONFLICTING_BOXES);
    assert.ok(a.reasons.includes('CROP_BOX_DIFFERS'));
    assert.equal(a.plan, null);
  });

  // ===== G. mixed =====
  await runCase('G. mixed page sizes -> mixed document, manual, no plan', async () => {
    const bytes = await make({ perPage: (i) => (i === 5 ? [595.28, 841.89] : [432, 648]) });
    const a = await assessPageGeometry(bytes, U_NOBLEED);
    assert.equal(a.category, CATEGORY.MIXED_DOCUMENT);
    assert.equal(a.tier, 5);
    assert.equal(a.plan, null);
  });

  await runCase('G. some pages with TrimBox and some without -> mixed, manual', async () => {
    const bytes = await make({ w: 432, h: 648, setup: (p, i) => i % 2 === 0 && p.setTrimBox(0, 0, 432, 648) });
    const a = await assessPageGeometry(bytes, U_NOBLEED);
    assert.equal(a.category, CATEGORY.MIXED_DOCUMENT);
    assert.equal(a.plan, null);
    assert.equal(a.trimBox, 'mixed');
  });

  // ===== H. rotation =====
  for (const deg of [90, 180, 270]) {
    await runCase(`H. /Rotate ${deg} -> rotated/uncertain, no plan, never touched`, async () => {
      const bytes = await make({ w: 432, h: 648, setup: (p, i) => i === 3 && p.setRotation(degrees(deg)) });
      const a = await assessPageGeometry(bytes, U_NOBLEED);
      assert.equal(a.category, CATEGORY.ROTATED_UNCERTAIN);
      assert.equal(a.tier, 5);
      assert.equal(a.plan, null);
      const res = await normalizePageGeometry(bytes, { userIntent: U_NOBLEED });
      assert.equal(res.applied, false);
      assert.ok(same(res.outputBytes, bytes));
    });
  }
  await runCase('H. /Rotate 0 and 360 are not rotation', async () => {
    const bytes = await make({ w: 432, h: 648, setup: (p) => p.setRotation(degrees(360)) });
    const a = await assessPageGeometry(bytes, U_NOBLEED);
    assert.equal(a.category, CATEGORY.EXACT_PAGE_NO_TRIM);
  });

  // ===== J. non-zero origin =====
  await runCase('J. non-zero page origin: TrimBox is written in the page\'s own coordinates', async () => {
    const bytes = await make({ w: 432, h: 648, setup: (p) => p.setMediaBox(10, 20, 432, 648), rects: [[110, 220, 100, 100]] });
    const a = await assessPageGeometry(bytes, U_NOBLEED);
    assert.equal(a.tier, 1);
    assert.deepEqual(a.plan.changes[0].set.trimBox, { x: 10, y: 20, width: 432, height: 648 });
    const res = await normalizePageGeometry(bytes, { userIntent: U_NOBLEED });
    assert.equal(res.applied, true);
    assert.equal(res.after.verdict, 'READY');
  });

  await runCase('J. non-zero origin with bleed: parity offset is applied on top of the origin', async () => {
    const bytes = await make({ w: 441, h: 666, setup: (p) => p.setMediaBox(10, 20, 441, 666) });
    const a = await assessPageGeometry(bytes, U_BLEED_LTR);
    assert.deepEqual(a.plan.changes[0].set.trimBox, { x: 10, y: 29, width: 432, height: 648 });
    assert.deepEqual(a.plan.changes[1].set.trimBox, { x: 19, y: 29, width: 432, height: 648 });
  });

  // ===== K/L. annotations + metadata preserved =====
  await runCase('K. annotations preserved (link annotation present before and after)', async () => {
    const bytes = await make({ w: 432, h: 648, annots: true });
    const res = await normalizePageGeometry(bytes, { userIntent: U_NOBLEED });
    assert.equal(res.applied, true);
    assert.ok(res.safety.checks.some((c) => c.id === 'ANNOTATIONS_UNCHANGED' && c.ok));
    const out = await PDFDocument.load(res.outputBytes);
    const arr = out.getPage(0).node.Annots();
    assert.equal(arr.size(), 1);
  });

  await runCase('L. metadata preserved byte-for-byte in the Info dictionary values', async () => {
    const bytes = await make({ w: 432, h: 648, meta: { title: 'My Book', author: 'Author Name' } });
    const res = await normalizePageGeometry(bytes, { userIntent: U_NOBLEED });
    assert.equal(res.applied, true);
    const out = await PDFDocument.load(res.outputBytes, { updateMetadata: false });
    assert.equal(out.getTitle(), 'My Book');
    assert.equal(out.getAuthor(), 'Author Name');
    assert.equal(out.getSubject(), 'subj');
    assert.deepEqual(out.getKeywords(), 'a b');
  });

  // ===== M/N. encrypted + signed =====
  await runCase('M. encrypted PDF -> DO NOT TOUCH, no plan, input returned', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < 30; i++) doc.addPage([432, 648]);
    const enc = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: PDFString.of('x'), U: PDFString.of('y'), P: -4 }));
    doc.context.trailerInfo.Encrypt = enc;
    const bytes = await doc.save();
    const a = await assessPageGeometry(bytes, U_NOBLEED);
    assert.equal(a.encrypted, true);
    assert.equal(a.category, CATEGORY.DO_NOT_TOUCH);
    assert.equal(a.tier, 5);
    assert.ok(a.reasons.includes('ENCRYPTED'));
    assert.equal(a.plan, null);
    const res = await normalizePageGeometry(bytes, { userIntent: U_NOBLEED });
    assert.equal(res.applied, false);
    assert.ok(same(res.outputBytes, bytes));
  });

  await runCase('N. digitally signed PDF -> DO NOT TOUCH', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < 30; i++) doc.addPage([432, 648]);
    const sigField = doc.context.register(doc.context.obj({ FT: 'Sig', T: PDFString.of('Signature1'), V: doc.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached' }) }));
    const acro = doc.context.obj({ Fields: [sigField], SigFlags: 3 });
    doc.catalog.set(PDFName.of('AcroForm'), acro);
    const bytes = await doc.save();
    const a = await assessPageGeometry(bytes, U_NOBLEED);
    assert.equal(a.signed, true);
    assert.equal(a.category, CATEGORY.DO_NOT_TOUCH);
    assert.ok(a.reasons.includes('SIGNED'));
    assert.equal(a.plan, null);
    const direct = await applyNormalization(bytes, { kind: 'ADD_TRIM_BOX', changes: [{ pageIndex: 0, set: { trimBox: { x: 0, y: 0, width: 432, height: 648 } } }] });
    assert.equal(direct.ok, false, 'apply itself refuses a signed document');
    assert.equal(direct.outputBytes, null);
  });

  // ===== Q. failure path keeps the original bytes =====
  await runCase('Q. a failed safety check returns no output and the original bytes survive', async () => {
    const bytes = await make({ w: 432, h: 648 });
    const copy = new Uint8Array(bytes);
    const bad = await applyNormalization(bytes, { kind: 'ADD_TRIM_BOX', changes: [{ pageIndex: 999, set: { trimBox: { x: 0, y: 0, width: 1, height: 1 } } }] });
    assert.equal(bad.ok, false);
    assert.equal(bad.outputBytes, null);
    assert.ok(same(bytes, copy), 'input bytes unchanged');
    const empty = await applyNormalization(bytes, null);
    assert.equal(empty.ok, false);
  });

  await runCase('garbage bytes -> LOAD_FAILED, never a plan', async () => {
    const a = await assessPageGeometry(new Uint8Array([1, 2, 3, 4]), U_NOBLEED);
    assert.equal(a.tier, 5);
    assert.ok(a.reasons.includes('LOAD_FAILED'));
    assert.equal(a.plan, null);
  });

  // ===== Verifier detection power (negative tests) =====
  // The safety verifier must FAIL CLOSED on every unexpected change. To prove
  // it detects them, setTrimBox is temporarily wrapped so that -- while the
  // legitimate plan is applied -- it ALSO performs a forbidden mutation.
  // Each case asserts the exact failure id, that no output bytes are
  // returned, and that the input bytes are untouched.
  const { PDFPage } = require('pdf-lib');

  async function withMutation(mutate, run, method = 'setTrimBox') {
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

  async function expectDetected(label, id, { bytes, intent = U_NOBLEED, mutate, method }) {
    await runCase(`verifier detects: ${label} -> ${id}`, async () => {
      const a = await assessPageGeometry(bytes, intent);
      assert.ok(a.plan, 'precondition: a legitimate plan exists');
      const snapshot = new Uint8Array(bytes);
      const res = await withMutation(mutate, () => applyNormalization(bytes, a.plan), method);
      assert.equal(res.ok, false, 'must fail closed');
      assert.equal(res.failure, id);
      assert.equal(res.outputBytes, null, 'no output when a check fails');
      assert.ok(same(bytes, snapshot), 'input bytes untouched');
      // control: without the mutation the same plan succeeds
      const control = await applyNormalization(bytes, a.plan);
      assert.equal(control.ok, true, 'control: unmutated apply passes every check');
    });
  }

  const withBleedBox = await make({ w: 432, h: 648, setup: (p) => p.setBleedBox(0, 0, 432, 648) });
  const withArtBox = await make({ w: 432, h: 648, setup: (p) => p.setArtBox(10, 10, 400, 600) });
  const withAnnots = await make({ w: 432, h: 648, annots: true });
  const plain = await make({ w: 432, h: 648 });

  await expectDetected('page content translated', 'CONTENT_STREAMS_CHANGED', { bytes: plain, mutate: (p) => p.translateContent(5, 5) });
  await expectDetected('page content scaled', 'CONTENT_STREAMS_CHANGED', { bytes: plain, mutate: (p) => p.scaleContent(0.9, 0.9) });
  await expectDetected('content operators appended', 'CONTENT_STREAMS_CHANGED', {
    bytes: plain,
    mutate: (p) => p.pushOperators(...rect(0, 0, 5, 5)),
  });
  await expectDetected('MediaBox changed', 'PAGE_GEOMETRY_CHANGED', { bytes: plain, mutate: (p) => p.setMediaBox(0, 0, 400, 600) });
  await expectDetected('CropBox added', 'PAGE_GEOMETRY_CHANGED', { bytes: plain, mutate: (p) => p.setCropBox(0, 0, 400, 600) });
  await expectDetected('page rotated', 'PAGE_GEOMETRY_CHANGED', { bytes: plain, mutate: (p) => p.setRotation(degrees(90)) });
  await expectDetected('annotations dropped', 'ANNOTATIONS_CHANGED', {
    bytes: withAnnots,
    mutate: (p) => p.node.delete(PDFName.of('Annots')),
  });
  await expectDetected('annotation Rect moved', 'ANNOTATIONS_CHANGED', {
    bytes: withAnnots,
    mutate: (p) => {
      const arr = p.node.Annots();
      if (arr) p.doc.context.lookup(arr.get(0)).set(PDFName.of('Rect'), p.doc.context.obj([1, 1, 2, 2]));
    },
  });
  await expectDetected('an EXISTING BleedBox rectangle changed (plan only adds TrimBox)', 'BLEED_BOX_CHANGED', {
    bytes: withBleedBox,
    mutate: (p) => p.setBleedBox(1, 1, 430, 640),
  });
  await expectDetected('a BleedBox appears that the Tier-1 plan does not include', 'BLEED_BOX_CHANGED', {
    bytes: plain,
    mutate: (p) => p.setBleedBox(0, 0, 432, 648),
  });
  await expectDetected('an ArtBox appears', 'ART_BOX_CHANGED', { bytes: plain, mutate: (p) => p.setArtBox(2, 2, 300, 300) });
  await expectDetected('an EXISTING ArtBox rectangle changed', 'ART_BOX_CHANGED', {
    bytes: withArtBox,
    mutate: (p) => p.setArtBox(11, 10, 400, 600),
  });
  await expectDetected('the TrimBox differs from the plan', 'TRIM_BOX_NOT_AS_PLANNED', {
    bytes: plain,
    mutate: (p) => p.setTrimBox(1, 1, 431, 647),
  });
  await expectDetected('Tier 2: the BleedBox differs from the plan', 'BLEED_BOX_NOT_AS_PLANNED', {
    bytes: await make({ w: 441, h: 666 }),
    intent: U_BLEED_LTR,
    method: 'setBleedBox', // mutate AFTER the plan's own setBleedBox so the change survives
    mutate: (p) => p.setBleedBox(0, 0, 440, 666),
  });

  await runCase('an existing, UNCHANGED BleedBox/ArtBox is preserved exactly and passes (no false alarm)', async () => {
    for (const bytes of [withBleedBox, withArtBox]) {
      const a = await assessPageGeometry(bytes, U_NOBLEED);
      const res = await applyNormalization(bytes, a.plan);
      assert.equal(res.ok, true);
      assert.ok(res.checks.some((c) => c.id === 'BLEED_ART_BOXES_UNCHANGED' && c.ok));
    }
  });

  console.log(`\npageGeometry.test.js: ${n} cases passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
