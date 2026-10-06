'use strict';

/**
 * Phase 2A v1: READ-ONLY PDF submission-integrity checks (lib/integrity.js) and
 * their roll-up into the single authoritative verdict (lib/orchestrator.js).
 *
 * The properties proven here:
 *   - every check returns structured findings with the right status/impact;
 *   - UNKNOWN never becomes PASS; a failing check is isolated and cannot hide another;
 *   - blocking findings cannot be hidden by unrelated PASS results;
 *   - Phase 2A can only make the verdict worse and can never produce READY;
 *   - the geometry result is untouched by the integrity layer;
 *   - nothing is ever written to the input bytes.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {
  PDFDocument,
  PDFName,
  PDFString,
  PDFHexString,
  StandardFonts,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  setFillingRgbColor,
  fill,
} = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const {
  runIntegrityChecks,
  rollUpVerdict,
  evaluateFileSize,
  effectiveDpi,
  CHECKS,
  CHECK_IDS,
  SIZE_LIMIT_MB_DECIMAL,
  SIZE_LIMIT_MB_BINARY,
} = require('../lib/integrity');
const { runPreflight, verifyAutofix } = require('../lib/orchestrator');

const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const U = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false };
const U_BLEED = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true, readingDirection: 'ltr' };
const N = (s) => PDFName.of(s);
const rectOps = (x, y, w, h) => [pushGraphicsState(), setFillingRgbColor(0.2, 0.2, 0.2), rectangle(x, y, w, h), fill(), popGraphicsState()];
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

let n = 0;
async function runCase(label, fn) {
  n += 1;
  await fn();
  console.log(`  [${n}] ${label}: OK`);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A clean 6x9 book: TrimBox, safe rectangle, embedded subset font. READY on its own. */
async function build({ pages = 30, w = 432, h = 648, trim = true, font = true, setup, perPage } = {}) {
  assert.ok(fs.existsSync(FONT_PATH), `fixture font missing: ${FONT_PATH}`);
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const f = font ? await doc.embedFont(fs.readFileSync(FONT_PATH), { subset: true }) : null;
  for (let i = 0; i < pages; i++) {
    const [pw, ph] = perPage ? perPage(i) : [w, h];
    const p = doc.addPage([pw, ph]);
    if (trim) p.setTrimBox(0, 0, pw, ph);
    p.pushOperators(...rectOps(100, 100, 100, 100));
    if (f) p.drawText(`page ${i + 1}`, { x: 100, y: 300, size: 12, font: f });
    if (setup) await setup(p, i, doc, f);
  }
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

const find = (r, id) => {
  const f = (r.checks || r.integrity.checks).find((c) => c.id === id);
  assert.ok(f, `finding ${id} exists`);
  return f;
};
const integrity = (bytes, intent = U, extra = {}) => runIntegrityChecks(bytes, { userIntent: intent, ...extra });

function annot(doc, dict) {
  return doc.context.register(doc.context.obj({ Type: 'Annot', Rect: [10, 10, 40, 40], ...dict }));
}
const addAnnots = (page, doc, ...dicts) => page.node.set(N('Annots'), doc.context.obj(dicts.map((d) => annot(doc, d))));

/** Minimal valid grayscale PNG-free raw image XObject. */
function imageXObject(doc, w, h, extra = {}) {
  return doc.context.register(doc.context.flateStream(new Uint8Array(w * h), { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8, ...extra }));
}
/** Replace a page's content with an exact content string and resources. */
function setContent(doc, page, content, resources) {
  const ref = doc.context.register(doc.context.stream(Buffer.from(content, 'latin1')));
  page.node.set(N('Contents'), ref);
  page.node.set(N('Resources'), doc.context.obj(resources));
}

// RC4 + the standard security handler (V1 R2, 40-bit): a REAL encrypted PDF.
const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
function rc4(key, data) {
  const S = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255;
    b = (b + S[a]) & 255;
    [S[a], S[b]] = [S[b], S[a]];
    out[k] = data[k] ^ S[(S[a] + S[b]) & 255];
  }
  return out;
}
const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const padPw = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
async function encryptPdf(bytes, { userPassword = '', ownerPassword = 'owner' } = {}) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const id0 = crypto.randomBytes(16);
  const O = rc4(md5(padPw(ownerPassword)).subarray(0, 5), padPw(userPassword));
  const P = Buffer.alloc(4);
  P.writeInt32LE(-4);
  const key = md5(padPw(userPassword), O, P, id0).subarray(0, 5);
  const U_ = rc4(key, PAD);
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj.contents instanceof Uint8Array) {
      const oid = Buffer.alloc(5);
      oid.writeUIntLE(ref.objectNumber, 0, 3);
      oid.writeUIntLE(ref.generationNumber, 3, 2);
      obj.contents = new Uint8Array(rc4(md5(key, oid).subarray(0, 10), Buffer.from(obj.contents)));
    }
  }
  const enc = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: PDFHexString.of(O.toString('hex')), U: PDFHexString.of(U_.toString('hex')), P: -4 }));
  doc.context.trailerInfo.Encrypt = enc;
  doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(id0.toString('hex')), PDFHexString.of(id0.toString('hex'))]);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

async function main() {
  // =========================================================================
  // 0. contract shape
  // =========================================================================
  await runCase('contract: exactly one structured finding per check, fixed order, derived impact', async () => {
    const r = await integrity(await build());
    assert.equal(r.version, 1);
    assert.deepEqual(r.checks.map((c) => c.id), CHECK_IDS);
    assert.deepEqual(CHECKS.map((c) => c.id), CHECK_IDS);
    for (const c of r.checks) {
      assert.ok(['PASS', 'FAIL', 'WARNING', 'UNKNOWN'].includes(c.status));
      assert.equal(c.impact, c.status === 'FAIL' ? 'BLOCKING' : c.status === 'PASS' ? 'NONE' : 'MANUAL_REVIEW');
      assert.equal(typeof c.code, 'string');
      assert.equal(typeof c.message, 'string');
      assert.equal(typeof c.category, 'string');
      assert.equal(typeof c.details, 'object');
    }
    assert.deepEqual(r.summary, { total: 11, passed: 11, blocking: 0, warning: 0, unknown: 0, manualReview: 0 });
    assert.equal(r.impact, 'NONE');
  });

  await runCase('read-only: inspection never changes the input bytes', async () => {
    const bytes = await build({ setup: (p, i, d) => addAnnots(p, d, { Subtype: 'Text' }) });
    const copy = new Uint8Array(bytes);
    await integrity(bytes);
    await runPreflight(bytes, { userIntent: U });
    assert.ok(sameBytes(bytes, copy));
  });

  // =========================================================================
  // 1. encryption / security
  // =========================================================================
  await runCase('SECURITY_ENCRYPTION: unencrypted -> PASS', async () => {
    assert.equal(find(await integrity(await build()), 'SECURITY_ENCRYPTION').status, 'PASS');
  });

  await runCase('SECURITY_ENCRYPTION: a real RC4-encrypted PDF (empty user password) -> FAIL ENCRYPTED', async () => {
    const enc = await encryptPdf(await build({ font: false }));
    const f = find(await integrity(enc), 'SECURITY_ENCRYPTION');
    assert.equal(f.status, 'FAIL');
    assert.equal(f.impact, 'BLOCKING');
    assert.equal(f.code, 'ENCRYPTED');
  });

  await runCase('SECURITY_ENCRYPTION: a bare /Encrypt entry -> FAIL as well', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < 3; i++) doc.addPage([432, 648]);
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: PDFString.of('x'), U: PDFString.of('y'), P: -4 }));
    assert.equal(find(await integrity(new Uint8Array(await doc.save())), 'SECURITY_ENCRYPTION').status, 'FAIL');
  });

  // =========================================================================
  // 2. bookmarks
  // =========================================================================
  const outlineDoc = async (mk) =>
    build({
      pages: 3,
      setup: (p, i, doc) => {
        if (i !== 0) return;
        const root = doc.context.nextRef();
        const items = mk(doc, root);
        doc.context.assign(root, doc.context.obj(items.rootDict));
        doc.catalog.set(N('Outlines'), root);
      },
    });
  const outlineItems = (doc, root, count, { cycle = false, nested = false } = {}) => {
    const refs = Array.from({ length: count }, () => doc.context.nextRef());
    refs.forEach((ref, i) => {
      const d = { Title: PDFString.of(`Item ${i + 1}`), Parent: root };
      if (i + 1 < count) d.Next = refs[i + 1];
      else if (cycle) d.Next = refs[0];
      if (nested && i === 0 && count > 2) d.First = refs[count - 1];
      doc.context.assign(ref, doc.context.obj(d));
    });
    return { rootDict: { Type: 'Outlines', First: refs[0], Last: refs[count - 1], Count: count } };
  };

  await runCase('BOOKMARKS: none -> PASS', async () => assert.equal(find(await integrity(await build()), 'BOOKMARKS').status, 'PASS'));
  await runCase('BOOKMARKS: an outline with items -> FAIL with the item count', async () => {
    const f = find(await integrity(await outlineDoc((d, root) => outlineItems(d, root, 3))), 'BOOKMARKS');
    assert.equal(f.status, 'FAIL');
    assert.equal(f.code, 'BOOKMARKS_PRESENT');
    assert.equal(f.details.items, 3);
  });
  await runCase('BOOKMARKS: nested items are counted; a cyclic /Next chain terminates', async () => {
    const nested = find(await integrity(await outlineDoc((d, root) => outlineItems(d, root, 4, { nested: true }))), 'BOOKMARKS');
    assert.equal(nested.status, 'FAIL');
    const cyc = find(await integrity(await outlineDoc((d, root) => outlineItems(d, root, 3, { cycle: true }))), 'BOOKMARKS');
    assert.equal(cyc.status, 'FAIL');
    assert.equal(cyc.details.items, 3);
  });
  await runCase('BOOKMARKS: an empty /Outlines dictionary is not a bookmark -> PASS (reported)', async () => {
    const f = find(await integrity(await outlineDoc(() => ({ rootDict: { Type: 'Outlines', Count: 0 } }))), 'BOOKMARKS');
    assert.equal(f.status, 'PASS');
    assert.equal(f.code, 'EMPTY_OUTLINES');
  });
  await runCase('BOOKMARKS: unreadable / inconsistent /Outlines -> UNKNOWN (never PASS)', async () => {
    const bad = await build({ pages: 2, setup: (p, i, d) => i === 0 && d.catalog.set(N('Outlines'), d.context.obj(7)) });
    const f = find(await integrity(bad), 'BOOKMARKS');
    assert.equal(f.status, 'UNKNOWN');
    assert.ok(f.diagnostics.length > 0);
    const incons = find(await integrity(await outlineDoc(() => ({ rootDict: { Type: 'Outlines', Count: 5 } }))), 'BOOKMARKS');
    assert.equal(incons.status, 'UNKNOWN');
  });

  // =========================================================================
  // 3. annotations / comments, links, forms
  // =========================================================================
  const withAnnots = (...dicts) => build({ pages: 3, setup: (p, i, doc) => i === 1 && addAnnots(p, doc, ...dicts) });

  for (const subtype of ['Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Ink', 'Square', 'Circle', 'Line', 'Caret', 'Popup']) {
    await runCase(`ANNOTATIONS_COMMENTS: ${subtype} -> FAIL (comment/markup), page reported`, async () => {
      const f = find(await integrity(await withAnnots({ Subtype: subtype })), 'ANNOTATIONS_COMMENTS');
      assert.equal(f.status, 'FAIL');
      assert.equal(f.code, 'COMMENTS_PRESENT');
      assert.deepEqual(f.pages, [2]);
      assert.equal(f.evidence.commentSubtypes[subtype], 1);
    });
  }

  await runCase('ANNOTATIONS: no annotations -> PASS', async () => assert.equal(find(await integrity(await build()), 'ANNOTATIONS_COMMENTS').status, 'PASS'));

  await runCase('ANNOTATIONS: a Link is NOT a comment (annotation check PASS) but the link check reports it', async () => {
    const r = await integrity(await withAnnots({ Subtype: 'Link', A: { S: 'URI', URI: PDFString.of('https://example.com') } }));
    assert.equal(find(r, 'ANNOTATIONS_COMMENTS').status, 'PASS');
    const l = find(r, 'LINK_ANNOTATIONS');
    assert.equal(l.status, 'WARNING');
    assert.equal(l.impact, 'MANUAL_REVIEW');
    assert.equal(l.code, 'LINKS_DETECTED');
    assert.deepEqual(l.pages, [2]);
    assert.equal(l.evidence.actions.URI, 1);
    assert.equal(r.impact, 'MANUAL_REVIEW', 'links alone never block');
  });

  await runCase('ANNOTATIONS: link action kinds (URI / GoTo / Dest) are distinguished in the evidence', async () => {
    const r = await withAnnots({ Subtype: 'Link', A: { S: 'GoTo', D: [] } }, { Subtype: 'Link', Dest: [] }, { Subtype: 'Link', A: { S: 'URI', URI: PDFString.of('x') } });
    const l = find(await integrity(r), 'LINK_ANNOTATIONS');
    assert.deepEqual(l.evidence.actions, { GoTo: 1, Dest: 1, URI: 1 });
  });

  await runCase('ANNOTATIONS: comments dominate links (FAIL) while links are still reported separately', async () => {
    const r = await integrity(await withAnnots({ Subtype: 'Link' }, { Subtype: 'Text' }));
    assert.equal(find(r, 'ANNOTATIONS_COMMENTS').status, 'FAIL');
    assert.equal(find(r, 'LINK_ANNOTATIONS').status, 'WARNING');
  });

  for (const subtype of ['Stamp', 'FileAttachment', 'Sound', 'Redact', 'PrinterMark', 'TrapNet', 'Watermark', 'Screen', 'SomethingNew']) {
    await runCase(`ANNOTATIONS: ${subtype} -> WARNING (policy for this subtype is not established), not a blanket FAIL`, async () => {
      const f = find(await integrity(await withAnnots({ Subtype: subtype })), 'ANNOTATIONS_COMMENTS');
      assert.equal(f.status, 'WARNING');
      assert.equal(f.impact, 'MANUAL_REVIEW');
      assert.equal(f.code, 'OTHER_ANNOTATION_TYPES');
    });
  }

  await runCase('ANNOTATIONS: an unreadable annotation entry -> UNKNOWN (cannot be PASS), and the link check is UNKNOWN too', async () => {
    const bytes = await build({ pages: 2, setup: (p, i, doc) => i === 0 && p.node.set(N('Annots'), doc.context.obj([42])) });
    const r = await integrity(bytes);
    assert.equal(find(r, 'ANNOTATIONS_COMMENTS').status, 'UNKNOWN');
    assert.equal(find(r, 'LINK_ANNOTATIONS').status, 'UNKNOWN');
  });

  await runCase('FORMS: a Widget annotation without an AcroForm -> WARNING; annotation check does not call it a comment', async () => {
    const r = await integrity(await withAnnots({ Subtype: 'Widget', FT: N('Tx') }));
    assert.equal(find(r, 'FORMS_WIDGETS').status, 'WARNING');
    assert.equal(find(r, 'FORMS_WIDGETS').code, 'FORMS_DETECTED');
    assert.equal(find(r, 'ANNOTATIONS_COMMENTS').status, 'PASS');
  });

  await runCase('FORMS: a real AcroForm text field (pdf-lib form) -> WARNING with field and widget counts', async () => {
    const bytes = await build({
      pages: 3,
      setup: (p, i, doc) => {
        if (i === 0) doc.getForm().createTextField('name').addToPage(p, { x: 100, y: 400, width: 120, height: 20 });
      },
    });
    const f = find(await integrity(bytes), 'FORMS_WIDGETS');
    assert.equal(f.status, 'WARNING');
    assert.equal(f.evidence.fields, 1);
    assert.equal(f.evidence.widgetAnnotations, 1);
    assert.deepEqual(f.pages, [1]);
  });

  await runCase('FORMS: an empty /AcroForm (no fields, no widgets) -> PASS EMPTY_ACROFORM; XFA -> WARNING; unreadable -> UNKNOWN', async () => {
    const empty = await build({ pages: 2, setup: (p, i, d) => i === 0 && d.catalog.set(N('AcroForm'), d.context.obj({ Fields: [] })) });
    const e = find(await integrity(empty), 'FORMS_WIDGETS');
    assert.equal(e.status, 'PASS');
    assert.equal(e.code, 'EMPTY_ACROFORM');
    const xfa = await build({ pages: 2, setup: (p, i, d) => i === 0 && d.catalog.set(N('AcroForm'), d.context.obj({ Fields: [], XFA: [] })) });
    assert.equal(find(await integrity(xfa), 'FORMS_WIDGETS').status, 'WARNING');
    const bad = await build({ pages: 2, setup: (p, i, d) => i === 0 && d.catalog.set(N('AcroForm'), d.context.obj(5)) });
    assert.equal(find(await integrity(bad), 'FORMS_WIDGETS').status, 'UNKNOWN');
  });

  // =========================================================================
  // 4. signatures
  // =========================================================================
  await runCase('DIGITAL_SIGNATURES: none -> PASS', async () => assert.equal(find(await integrity(await build()), 'DIGITAL_SIGNATURES').status, 'PASS'));

  await runCase('DIGITAL_SIGNATURES: a signature dictionary with /ByteRange -> WARNING (manual), NOT a KDP-prohibited FAIL', async () => {
    const bytes = await build({
      pages: 2,
      setup: (p, i, doc) => {
        if (i !== 0) return;
        const sig = doc.context.register(doc.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', ByteRange: [0, 10, 20, 30], Contents: PDFHexString.of('00') }));
        const field = doc.context.register(doc.context.obj({ FT: 'Sig', T: PDFString.of('S1'), V: sig }));
        doc.catalog.set(N('AcroForm'), doc.context.obj({ Fields: [field], SigFlags: 3 }));
      },
    });
    const f = find(await integrity(bytes), 'DIGITAL_SIGNATURES');
    assert.equal(f.status, 'WARNING');
    assert.equal(f.impact, 'MANUAL_REVIEW');
    assert.equal(f.code, 'SIGNATURE_DETECTED');
    assert.ok(f.evidence.signatureObjects >= 1);
    assert.equal(f.evidence.sigFlags, 3);
  });

  await runCase('DIGITAL_SIGNATURES: DocMDP (/Perms) and a document timestamp are detected', async () => {
    const perms = await build({ pages: 2, setup: (p, i, d) => i === 0 && d.catalog.set(N('Perms'), d.context.obj({})) });
    assert.equal(find(await integrity(perms), 'DIGITAL_SIGNATURES').status, 'WARNING');
    const ts = await build({ pages: 2, setup: (p, i, d) => i === 0 && d.context.register(d.context.obj({ Type: 'DocTimeStamp', ByteRange: [0, 1, 2, 3] })) });
    const f = find(await integrity(ts), 'DIGITAL_SIGNATURES');
    assert.equal(f.status, 'WARNING');
    assert.equal(f.evidence.documentTimestamps, 1);
  });

  await runCase('DIGITAL_SIGNATURES: an UNSIGNED signature field is a form field, not a signature', async () => {
    const bytes = await build({
      pages: 2,
      setup: (p, i, doc) => {
        if (i !== 0) return;
        const field = doc.context.register(doc.context.obj({ FT: 'Sig', T: PDFString.of('S1') }));
        doc.catalog.set(N('AcroForm'), doc.context.obj({ Fields: [field] }));
      },
    });
    const r = await integrity(bytes);
    assert.equal(find(r, 'DIGITAL_SIGNATURES').status, 'PASS');
    assert.equal(find(r, 'FORMS_WIDGETS').status, 'WARNING');
  });

  // =========================================================================
  // 5. file size
  // =========================================================================
  await runCase('FILE_SIZE: boundaries (650 MB decimal / 650 MiB) -> PASS / UNKNOWN (ambiguous window) / FAIL', async () => {
    assert.equal(SIZE_LIMIT_MB_DECIMAL, 650000000);
    assert.equal(SIZE_LIMIT_MB_BINARY, 681574400);
    const cases = [
      [0, 'PASS'], [1, 'PASS'], [650000000, 'PASS'],
      [650000001, 'UNKNOWN'], [681574400, 'UNKNOWN'],
      [681574401, 'FAIL'], [2 * 1024 ** 3, 'FAIL'],
      [NaN, 'UNKNOWN'], [-1, 'UNKNOWN'], [undefined, 'UNKNOWN'],
    ];
    for (const [size, status] of cases) assert.equal(evaluateFileSize(size).status, status, `size ${size}`);
  });

  await runCase('FILE_SIZE: through the runner (no giant fixture needed): over-limit blocks, in-window is manual, small passes', async () => {
    const bytes = await build({ pages: 2 });
    const over = find(await integrity(bytes, U, { fileSize: 700 * 1000 * 1000 }), 'FILE_SIZE');
    assert.equal(over.status, 'FAIL');
    assert.equal(over.code, 'OVER_LIMIT');
    assert.equal(over.impact, 'BLOCKING');
    assert.equal(find(await integrity(bytes, U, { fileSize: 660 * 1000 * 1000 }), 'FILE_SIZE').status, 'UNKNOWN');
    assert.equal(find(await integrity(bytes, U, { fileSize: 649 * 1000 * 1000 }), 'FILE_SIZE').status, 'PASS');
    assert.equal(find(await integrity(bytes), 'FILE_SIZE').details.sizeBytes, bytes.length, 'default = the real byte length');
  });

  // =========================================================================
  // 6. fonts
  // =========================================================================
  const fontFile = (doc) => doc.context.register(doc.context.stream(Buffer.from('dummy font program')));
  const setFonts = (page, doc, fonts) => {
    const fdict = {};
    Object.entries(fonts).forEach(([k, v]) => (fdict[k] = v));
    const res = page.node.Resources();
    res.set(N('Font'), doc.context.obj(fdict));
  };
  const fontsDoc = (mk) => build({ pages: 2, font: false, setup: (p, i, doc) => i === 0 && setFonts(p, doc, mk(doc)) });
  const descriptor = (doc, name, file) => doc.context.register(doc.context.obj({ Type: 'FontDescriptor', FontName: N(name), Flags: 4, ...(file ? file : {}) }));

  await runCase('FONTS: a real embedded font (fontkit, glyph-subset program) -> PASS (subset is counted only when the name carries the standard ABCDEF+ tag)', async () => {
    const f = find(await integrity(await build({ pages: 2 })), 'FONTS_EMBEDDED');
    assert.equal(f.status, 'PASS');
    assert.equal(f.code, 'ALL_EMBEDDED');
    assert.equal(f.evidence.embedded, 1);
    assert.equal(f.evidence.notEmbedded, 0);
    assert.equal(f.evidence.subsetEmbedded, 0, 'pdf-lib does not write the ABCDEF+ tag; the PASS does not depend on it');
  });

  await runCase('FONTS: pdf-lib StandardFonts (Helvetica) are not embedded -> FAIL NOT_EMBEDDED with name and pages', async () => {
    const bytes = await build({
      pages: 3,
      font: false,
      setup: async (p, i, doc) => {
        const h = await doc.embedFont(StandardFonts.Helvetica);
        p.drawText('hi', { x: 100, y: 300, size: 12, font: h });
      },
    });
    const f = find(await integrity(bytes), 'FONTS_EMBEDDED');
    assert.equal(f.status, 'FAIL');
    assert.equal(f.impact, 'BLOCKING');
    assert.equal(f.code, 'NOT_EMBEDDED');
    assert.ok(f.objects.includes('Helvetica'));
    assert.deepEqual(f.pages, [1, 2, 3]);
  });

  await runCase('FONTS: Type1 / TrueType / Type0 with a font file (FontFile, FontFile2, FontFile3) -> PASS', async () => {
    const bytes = await fontsDoc((doc) => {
      const t1 = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: N('ABCDEF+MyFont'), FontDescriptor: descriptor(doc, 'ABCDEF+MyFont', { FontFile: fontFile(doc) }) }));
      const tt = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: N('Body'), FontDescriptor: descriptor(doc, 'Body', { FontFile2: fontFile(doc) }) }));
      const cid = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'CIDFontType0', BaseFont: N('Cid'), FontDescriptor: descriptor(doc, 'Cid', { FontFile3: fontFile(doc) }) }));
      const t0 = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: N('Cid'), DescendantFonts: [cid] }));
      return { F1: t1, F2: tt, F3: t0 };
    });
    const f = find(await integrity(bytes), 'FONTS_EMBEDDED');
    assert.equal(f.status, 'PASS');
    assert.equal(f.evidence.embedded, 3);
    assert.equal(f.evidence.subsetEmbedded, 1);
  });

  await runCase('FONTS: a descriptor WITHOUT a font file is not embedded -> FAIL', async () => {
    const bytes = await fontsDoc((doc) => ({ F1: doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: N('Arial'), FontDescriptor: descriptor(doc, 'Arial') })) }));
    assert.equal(find(await integrity(bytes), 'FONTS_EMBEDDED').status, 'FAIL');
  });

  await runCase('FONTS: a standard-14 font without a descriptor -> FAIL; an unknown font without a descriptor -> UNKNOWN', async () => {
    const std = await fontsDoc((doc) => ({ F1: doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: N('Times-Roman') })) }));
    assert.equal(find(await integrity(std), 'FONTS_EMBEDDED').status, 'FAIL');
    const unk = await fontsDoc((doc) => ({ F1: doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: N('MyStrangeFont') })) }));
    const f = find(await integrity(unk), 'FONTS_EMBEDDED');
    assert.equal(f.status, 'UNKNOWN');
    assert.equal(f.impact, 'MANUAL_REVIEW');
    assert.ok(f.diagnostics.length > 0);
  });

  await runCase('FONTS: Type3 fonts carry their glyphs -> PASS; a Type0 without a readable descendant -> UNKNOWN', async () => {
    const t3 = await fontsDoc((doc) => ({ F1: doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 1, 1], FontMatrix: [1, 0, 0, 1, 0, 0], CharProcs: {}, Encoding: {} })) }));
    assert.equal(find(await integrity(t3), 'FONTS_EMBEDDED').status, 'PASS');
    const t0 = await fontsDoc((doc) => ({ F1: doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: N('X') })) }));
    assert.equal(find(await integrity(t0), 'FONTS_EMBEDDED').status, 'UNKNOWN');
  });

  await runCase('FONTS: a blocker is not hidden by an unknown font or by embedded ones; unknown alone is MANUAL, never PASS', async () => {
    const bytes = await fontsDoc((doc) => ({
      A: doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: N('Helvetica') })),
      B: doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: N('Mystery') })),
      C: doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: N('Ok'), FontDescriptor: descriptor(doc, 'Ok', { FontFile2: fontFile(doc) }) })),
    }));
    const f = find(await integrity(bytes), 'FONTS_EMBEDDED');
    assert.equal(f.status, 'FAIL');
    assert.equal(f.evidence.undetermined, 1);
    assert.equal(f.evidence.embedded, 1);
  });

  await runCase('FONTS: fonts reached through a Form XObject, a Type3 font\'s resources and inherited resources are found', async () => {
    const viaForm = await build({
      pages: 2,
      font: false,
      setup: (p, i, doc) => {
        if (i !== 0) return;
        const hv = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: N('Helvetica') }));
        const form = doc.context.register(doc.context.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: { Font: { F1: hv } } }));
        p.node.Resources().set(N('XObject'), doc.context.obj({ Fm1: form }));
      },
    });
    assert.equal(find(await integrity(viaForm), 'FONTS_EMBEDDED').status, 'FAIL');
    const inherited = await build({
      pages: 2,
      font: false,
      setup: (p, i, doc) => {
        if (i !== 0) return;
        const hv = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: N('Courier') }));
        doc.catalog.lookup(N('Pages')).set(N('Resources'), doc.context.obj({ Font: { F1: hv } }));
        p.node.delete(N('Resources'));
      },
    });
    assert.equal(find(await integrity(inherited), 'FONTS_EMBEDDED').status, 'FAIL');
  });

  await runCase('FONTS: a malformed /Font entry cannot be PASS -> UNKNOWN; no fonts at all -> PASS NO_FONTS', async () => {
    const bad = await build({ pages: 2, font: false, setup: (p, i, doc) => i === 0 && p.node.Resources().set(N('Font'), doc.context.obj({ F1: 12 })) });
    assert.equal(find(await integrity(bad), 'FONTS_EMBEDDED').status, 'UNKNOWN');
    const none = find(await integrity(await build({ font: false })), 'FONTS_EMBEDDED');
    assert.equal(none.status, 'PASS');
    assert.equal(none.code, 'NO_FONTS');
  });

  // =========================================================================
  // 7. image DPI
  // =========================================================================
  const imageDoc = (placements, { resourcesExtra = {}, content } = {}) =>
    build({
      pages: 2,
      font: false,
      setup: (p, i, doc) => {
        if (i !== 0) return;
        const xobj = {};
        let body = '';
        placements.forEach((pl, k) => {
          xobj[`Im${k}`] = imageXObject(doc, pl.px[0], pl.px[1]);
          body += `q ${pl.cm.join(' ')} cm /Im${k} Do Q\n`;
        });
        setContent(doc, p, content ?? body, { XObject: xobj, ...resourcesExtra });
      },
    });

  await runCase('IMAGE_DPI: effectiveDpi arithmetic (scale, rotation, anisotropy, UserUnit, degenerate)', async () => {
    assert.deepEqual(effectiveDpi(300, 300, [72, 0, 0, 72, 0, 0]), { dpiX: 300, dpiY: 300 });
    const rot = effectiveDpi(600, 300, [0, 144, -72, 0, 0, 0]); // rotated 90 degrees, 144pt x 72pt
    assert.ok(Math.abs(rot.dpiX - 300) < 1e-9 && Math.abs(rot.dpiY - 300) < 1e-9);
    assert.equal(effectiveDpi(100, 100, [0, 0, 0, 0, 0, 0]), null);
    assert.equal(effectiveDpi(0, 10, [72, 0, 0, 72, 0, 0]), null);
    const uu = effectiveDpi(100, 100, [72, 0, 0, 72, 0, 0], 2);
    assert.equal(uu.dpiX, 50);
  });

  await runCase('IMAGE_DPI: 600 dpi and exactly 300 dpi -> PASS', async () => {
    const f = find(await integrity(await imageDoc([{ px: [600, 600], cm: [72, 0, 0, 72, 100, 100] }, { px: [300, 300], cm: [72, 0, 0, 72, 100, 300] }])), 'IMAGE_DPI');
    assert.equal(f.status, 'PASS');
    assert.equal(f.code, 'ALL_AT_OR_ABOVE_REFERENCE');
    assert.equal(f.evidence.imagePlacements, 2);
    assert.equal(f.evidence.minEffectiveDpi, 300);
  });

  await runCase('IMAGE_DPI: below 300 dpi -> WARNING (manual), with page, name, pixel size and effective dpi', async () => {
    const f = find(await integrity(await imageDoc([{ px: [100, 100], cm: [72, 0, 0, 72, 100, 100] }, { px: [600, 600], cm: [72, 0, 0, 72, 100, 300] }])), 'IMAGE_DPI');
    assert.equal(f.status, 'WARNING');
    assert.equal(f.impact, 'MANUAL_REVIEW');
    assert.equal(f.code, 'LOW_EFFECTIVE_DPI');
    assert.equal(f.evidence.belowReference, 1);
    assert.equal(f.evidence.minEffectiveDpi, 100);
    assert.deepEqual(f.details.images[0], { page: 1, name: 'Im0', pixels: '100x100', effectiveDpi: 100, dpiX: 100, dpiY: 100 });
    assert.deepEqual(f.pages, [1]);
  });

  await runCase('IMAGE_DPI: no invented 200/250 thresholds: 299 dpi and 150 dpi are reported the same way (WARNING), 299.6 rounds to a pass', async () => {
    for (const px of [150, 299]) assert.equal(find(await integrity(await imageDoc([{ px: [px, px], cm: [72, 0, 0, 72, 100, 100] }])), 'IMAGE_DPI').status, 'WARNING', `${px} dpi`);
    // 300 px over 72.1 pt = 299.58 dpi: within the half-dpi rounding allowance
    assert.equal(find(await integrity(await imageDoc([{ px: [300, 300], cm: [72.1, 0, 0, 72.1, 100, 100] }])), 'IMAGE_DPI').status, 'PASS');
    // 300 px over 72.2 pt = 299.17 dpi: below
    assert.equal(find(await integrity(await imageDoc([{ px: [300, 300], cm: [72.2, 0, 0, 72.2, 100, 100] }])), 'IMAGE_DPI').status, 'WARNING');
  });

  await runCase('IMAGE_DPI: anisotropic placement uses the worse axis; rotated placement is measured on the rotated axes', async () => {
    const aniso = find(await integrity(await imageDoc([{ px: [600, 100], cm: [72, 0, 0, 72, 100, 100] }])), 'IMAGE_DPI');
    assert.equal(aniso.status, 'WARNING');
    assert.equal(aniso.evidence.minEffectiveDpi, 100);
    const rotated = find(await integrity(await imageDoc([{ px: [600, 300], cm: [0, 144, -72, 0, 300, 100] }])), 'IMAGE_DPI');
    assert.equal(rotated.status, 'PASS');
  });

  await runCase('IMAGE_DPI: nested q/cm state is multiplied correctly (scale applied through two cm operators)', async () => {
    const content = 'q 0.5 0 0 0.5 0 0 cm q 144 0 0 144 100 100 cm /Im0 Do Q Q\n'; // net 72 pt -> 300 px = 300 dpi
    const ok = await imageDoc([{ px: [300, 300], cm: [1, 0, 0, 1, 0, 0] }], { content });
    assert.equal(find(await integrity(ok), 'IMAGE_DPI').status, 'PASS');
    const low = await imageDoc([{ px: [299, 299], cm: [1, 0, 0, 1, 0, 0] }], { content });
    assert.equal(find(await integrity(low), 'IMAGE_DPI').status, 'WARNING');
  });

  await runCase('IMAGE_DPI: an image inside a Form XObject is measured through the form Matrix and the placement CTM', async () => {
    const mk = (px) =>
      build({
        pages: 2,
        font: false,
        setup: (p, i, doc) => {
          if (i !== 0) return;
          const im = imageXObject(doc, px, px);
          const form = doc.context.register(doc.context.stream('q 144 0 0 144 0 0 cm /Im0 Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 144, 144], Matrix: [0.5, 0, 0, 0.5, 0, 0], Resources: { XObject: { Im0: im } } }));
          setContent(doc, p, 'q 1 0 0 1 100 100 cm /Fm0 Do Q', { XObject: { Fm0: form } }); // 144 pt * 0.5 = 72 pt
        },
      });
    assert.equal(find(await integrity(await mk(300)), 'IMAGE_DPI').status, 'PASS');
    assert.equal(find(await integrity(await mk(200)), 'IMAGE_DPI').status, 'WARNING');
  });

  await runCase('IMAGE_DPI: an inline image is measured; an unreadable one is not PASS', async () => {
    const mk = (hdr) =>
      build({
        pages: 2,
        font: false,
        setup: (p, i, doc) => {
          if (i !== 0) return;
          const data = Buffer.alloc(100).toString('latin1');
          setContent(doc, p, `q 72 0 0 72 100 100 cm\nBI ${hdr} ID ${data}\nEI Q\n`, {});
        },
      });
    const low = find(await integrity(await mk('/W 10 /H 10 /CS /G /BPC 8')), 'IMAGE_DPI');
    assert.equal(low.status, 'WARNING');
    assert.equal(low.evidence.minEffectiveDpi, 10);
    assert.equal(find(await integrity(await mk('/CS /G /BPC 8')), 'IMAGE_DPI').status, 'UNKNOWN');
  });

  await runCase('IMAGE_DPI: no images -> PASS NO_IMAGES', async () => {
    const f = find(await integrity(await build({ font: false })), 'IMAGE_DPI');
    assert.equal(f.status, 'PASS');
    assert.equal(f.code, 'NO_IMAGES');
  });

  await runCase('IMAGE_DPI: cannot be calculated -> UNKNOWN (missing size, missing XObject, degenerate placement, tiling pattern)', async () => {
    const noSize = await build({
      pages: 2,
      font: false,
      setup: (p, i, doc) => {
        if (i !== 0) return;
        const im = doc.context.register(doc.context.stream(Buffer.alloc(4), { Type: 'XObject', Subtype: 'Image', ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
        setContent(doc, p, 'q 72 0 0 72 0 0 cm /Im0 Do Q', { XObject: { Im0: im } });
      },
    });
    assert.equal(find(await integrity(noSize), 'IMAGE_DPI').status, 'UNKNOWN');
    const missing = await build({ pages: 2, font: false, setup: (p, i, doc) => i === 0 && setContent(doc, p, 'q 72 0 0 72 0 0 cm /Nope Do Q', {}) });
    assert.equal(find(await integrity(missing), 'IMAGE_DPI').status, 'UNKNOWN');
    const degenerate = await imageDoc([{ px: [300, 300], cm: [0, 0, 0, 0, 100, 100] }]);
    assert.equal(find(await integrity(degenerate), 'IMAGE_DPI').status, 'UNKNOWN');
    const tiling = await build({
      pages: 2,
      font: false,
      setup: (p, i, doc) => {
        if (i !== 0) return;
        const pat = doc.context.register(doc.context.stream('', { Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 1, 1], XStep: 1, YStep: 1, Resources: {} }));
        p.node.Resources().set(N('Pattern'), doc.context.obj({ P1: pat }));
      },
    });
    const t = find(await integrity(tiling), 'IMAGE_DPI');
    assert.equal(t.status, 'UNKNOWN');
    assert.equal(t.evidence.tilingPatterns, 1);
  });

  await runCase('IMAGE_DPI: an undecodable content stream -> UNKNOWN with a diagnostic (the other checks still run)', async () => {
    const bytes = await build({
      pages: 2,
      font: false,
      setup: (p, i, doc) => {
        if (i !== 0) return;
        const ref = doc.context.register(doc.context.stream(Buffer.from('not really deflated'), { Filter: 'FlateDecode' }));
        p.node.set(N('Contents'), ref);
      },
    });
    const r = await integrity(bytes);
    const f = find(r, 'IMAGE_DPI');
    assert.equal(f.status, 'UNKNOWN');
    assert.equal(f.code, 'CHECK_FAILED');
    assert.ok(f.diagnostics.length > 0);
    assert.equal(find(r, 'FILE_SIZE').status, 'PASS');
    assert.equal(find(r, 'SECURITY_ENCRYPTION').status, 'PASS');
  });

  await runCase('IMAGE_DPI: low-DPI plus an unresolved image is still a WARNING (never silently better)', async () => {
    const bytes = await build({
      pages: 2,
      font: false,
      setup: (p, i, doc) => {
        if (i !== 0) return;
        setContent(doc, p, 'q 72 0 0 72 0 0 cm /Im0 Do Q q 72 0 0 72 0 100 cm /Gone Do Q', { XObject: { Im0: imageXObject(doc, 50, 50) } });
      },
    });
    const f = find(await integrity(bytes), 'IMAGE_DPI');
    assert.equal(f.status, 'WARNING');
    assert.equal(f.evidence.unresolvedPlacements, 1);
  });

  // =========================================================================
  // 8. spreads
  // =========================================================================
  await runCase('SPREADS: single pages at the selected trim -> PASS', async () => assert.equal(find(await integrity(await build()), 'SPREADS').status, 'PASS'));

  await runCase('SPREADS: pages exactly 2x the selected trim width (12x9 for a 6x9 book) -> FAIL (conclusive from the trim context)', async () => {
    const f = find(await integrity(await build({ w: 864, h: 648 })), 'SPREADS');
    assert.equal(f.status, 'FAIL');
    assert.equal(f.code, 'SPREAD_DETECTED');
    assert.equal(f.impact, 'BLOCKING');
    assert.equal(f.evidence.spreadMatches, 30);
  });

  await runCase('SPREADS: with bleed selected the spread size uses the KDP bleed constants (2x trim + outer bleed on both sides)', async () => {
    const f = find(await integrity(await build({ w: 882, h: 666 }), U_BLEED), 'SPREADS');
    assert.equal(f.status, 'FAIL');
    assert.equal(find(await integrity(await build({ w: 441, h: 666 }), U_BLEED), 'SPREADS').status, 'PASS', 'a single page with bleed is not a spread');
  });

  await runCase('SPREADS: an ambiguous landscape page is MANUAL (WARNING), not a hard FAIL from aspect ratio', async () => {
    const f = find(await integrity(await build({ w: 648, h: 432 })), 'SPREADS');
    assert.equal(f.status, 'WARNING');
    assert.equal(f.code, 'AMBIGUOUS_LANDSCAPE');
    assert.equal(f.impact, 'MANUAL_REVIEW');
    const wide = find(await integrity(await build({ w: 700, h: 648 })), 'SPREADS'); // landscape-ish, not exactly 2x
    assert.equal(wide.status, 'WARNING');
  });

  await runCase('SPREADS: a landscape TRIM context makes portrait pages unremarkable; a wrong-size portrait page is not a spread finding', async () => {
    const ctx = { trimSize: { widthIn: 9, heightIn: 6 }, bleed: false };
    assert.equal(find(await integrity(await build({ w: 432, h: 648 }), ctx), 'SPREADS').status, 'PASS');
    assert.equal(find(await integrity(await build({ w: 396, h: 612 })), 'SPREADS').status, 'PASS', 'size mismatch is the geometry preflight\'s business');
  });

  await runCase('SPREADS: a 2x-wide page whose explicit TrimBox is the single trim size is a single page with extra area', async () => {
    const bytes = await build({ w: 864, h: 648, trim: false, setup: (p) => p.setTrimBox(216, 0, 432, 648) });
    assert.equal(find(await integrity(bytes), 'SPREADS').status, 'PASS');
  });

  await runCase('SPREADS: without the user\'s trim context nothing is inferred -> UNKNOWN', async () => {
    for (const intent of [{}, { bleed: false }, { trimSize: U.trimSize }]) {
      const f = find(await integrity(await build({ w: 864, h: 648 }), intent), 'SPREADS');
      assert.equal(f.status, 'UNKNOWN');
      assert.equal(f.code, 'TRIM_CONTEXT_MISSING');
    }
  });

  // =========================================================================
  // 9. orientation
  // =========================================================================
  await runCase('ORIENTATION: all portrait / all landscape / squares -> PASS', async () => {
    assert.equal(find(await integrity(await build()), 'ORIENTATION').status, 'PASS');
    assert.equal(find(await integrity(await build({ w: 648, h: 432 })), 'ORIENTATION').status, 'PASS');
    assert.equal(find(await integrity(await build({ w: 500, h: 500 })), 'ORIENTATION').status, 'PASS');
  });

  await runCase('ORIENTATION: portrait and landscape pages mixed -> FAIL, minority pages listed', async () => {
    const f = find(await integrity(await build({ perPage: (i) => (i === 4 || i === 9 ? [648, 432] : [432, 648]) })), 'ORIENTATION');
    assert.equal(f.status, 'FAIL');
    assert.equal(f.code, 'MIXED_ORIENTATION');
    assert.deepEqual(f.pages, [5, 10]);
    assert.equal(f.evidence.portraitPages, 28);
  });

  await runCase('ORIENTATION: rotation is Phase 1\'s territory -> rotated pages are not assessed (UNKNOWN), never contradicted', async () => {
    const f = find(await integrity(await build({ setup: (p, i) => i === 2 && p.setRotation(degrees(90)) })), 'ORIENTATION');
    assert.equal(f.status, 'UNKNOWN');
    assert.equal(f.code, 'ROTATED_PAGES_NOT_ASSESSED');
    assert.deepEqual(f.pages, [3]);
    // a mix among the UNROTATED pages is still deterministic
    const mixed = await build({ perPage: (i) => (i === 1 ? [648, 432] : [432, 648]), setup: (p, i) => i === 2 && p.setRotation(degrees(90)) });
    assert.equal(find(await integrity(mixed), 'ORIENTATION').status, 'FAIL');
  });

  await runCase('ORIENTATION: effective size honors the CropBox', async () => {
    const f = find(await integrity(await build({ setup: (p, i) => i === 0 && p.setCropBox(0, 0, 648 > 432 ? 400 : 0, 300) })), 'ORIENTATION');
    assert.equal(f.status, 'FAIL'); // page 1 is cropped to 400 x 300 (landscape) among portrait pages
  });

  // =========================================================================
  // 10. isolation and fail-closed behavior
  // =========================================================================
  await runCase('ISOLATION: a throwing check becomes UNKNOWN (CHECK_FAILED) and every other check still runs', async () => {
    const checks = CHECKS.map((c) => (c.id === 'FONTS_EMBEDDED' ? { id: c.id, run: () => { throw new Error('font parser exploded'); } } : c));
    const r = await integrity(await build(), U, { checks });
    const f = find(r, 'FONTS_EMBEDDED');
    assert.equal(f.status, 'UNKNOWN');
    assert.equal(f.code, 'CHECK_FAILED');
    assert.match(f.diagnostics[0].message, /font parser exploded/);
    for (const c of r.checks.filter((x) => x.id !== 'FONTS_EMBEDDED')) assert.equal(c.status, 'PASS', c.id);
    assert.equal(r.impact, 'MANUAL_REVIEW');
    assert.equal(r.summary.unknown, 1);
  });

  await runCase('ISOLATION: a failing check cannot hide a blocker found by another check', async () => {
    const bytes = await build({ setup: (p, i, d) => i === 1 && addAnnots(p, d, { Subtype: 'Text' }) });
    const checks = CHECKS.map((c) => (c.id === 'IMAGE_DPI' ? { id: c.id, run: () => { throw new Error('boom'); } } : c));
    const r = await integrity(bytes, U, { checks });
    assert.equal(find(r, 'ANNOTATIONS_COMMENTS').status, 'FAIL');
    assert.equal(find(r, 'IMAGE_DPI').status, 'UNKNOWN');
    assert.equal(r.impact, 'BLOCKING');
  });

  await runCase('ISOLATION: a check returning garbage / the wrong id / a forged PASS shape is UNKNOWN, never PASS', async () => {
    const bad = [
      { id: 'BOOKMARKS', run: () => undefined },
      { id: 'BOOKMARKS', run: () => ({ id: 'SOMETHING_ELSE', status: 'PASS' }) },
      { id: 'BOOKMARKS', run: () => ({ id: 'BOOKMARKS', status: 'FINE' }) },
    ];
    for (const check of bad) {
      const r = await integrity(await build({ pages: 2 }), U, { checks: [check] });
      assert.equal(r.checks[0].status, 'UNKNOWN');
      assert.equal(r.checks[0].code, 'CHECK_FAILED');
    }
  });

  await runCase('FAIL CLOSED: an unreadable PDF -> every structure check UNKNOWN (LOAD_FAILED); the file-size check is still evaluated', async () => {
    const r = await integrity(new Uint8Array(Buffer.from('%PDF-1.4\nthis is not really a pdf')), U);
    for (const c of r.checks) {
      if (c.id === 'FILE_SIZE') assert.equal(c.status, 'PASS');
      else if (c.id === 'SPREADS' || c.id === 'ORIENTATION') assert.equal(c.status, 'UNKNOWN');
      else assert.equal(c.status, 'UNKNOWN', c.id);
    }
    assert.ok(r.checks.filter((c) => c.id !== 'FILE_SIZE').every((c) => c.code === 'LOAD_FAILED'));
    assert.equal(r.impact, 'MANUAL_REVIEW');
  });

  // =========================================================================
  // 11. roll-up (pure)
  // =========================================================================
  const F = (status) => ({ id: 'X', status, impact: status === 'FAIL' ? 'BLOCKING' : status === 'PASS' ? 'NONE' : 'MANUAL_REVIEW' });
  const I = (...statuses) => ({ checks: statuses.map(F) });
  const R = 'READY';
  const NA = 'NEEDS_ATTENTION';
  const M = 'MANUAL_REVIEW_REQUIRED';

  await runCase('ROLL-UP table: geometry NEEDS_ATTENTION or any blocker -> NEEDS_ATTENTION; geometry MANUAL or any manual/unknown -> MANUAL; else READY', async () => {
    const rows = [
      [R, I('PASS', 'PASS'), R],
      [R, I('PASS', 'FAIL'), NA],
      [R, I('WARNING'), M],
      [R, I('UNKNOWN'), M],
      [R, I('FAIL', 'WARNING', 'UNKNOWN'), NA],
      [NA, I('PASS'), NA],
      [NA, I('WARNING'), NA],
      [NA, I('FAIL'), NA],
      [M, I('PASS'), M],
      [M, I('WARNING'), M],
      [M, I('FAIL'), NA], // a deterministic blocker is reported as the verdict; the geometry manual items stay listed
    ];
    for (const [g, i, expected] of rows) assert.equal(rollUpVerdict(g, i), expected, `${g} + ${i.checks.map((c) => c.status)}`);
  });

  await runCase('ROLL-UP: Phase 2A can NEVER manufacture READY (exhaustive over geometry verdicts x every finding combination)', async () => {
    const geoVerdicts = [R, NA, M, 'garbage', undefined, null, ''];
    const statuses = ['PASS', 'FAIL', 'WARNING', 'UNKNOWN'];
    let combos = 0;
    for (const g of geoVerdicts) {
      for (const a of statuses) for (const b of statuses) for (const c of statuses) {
        const v = rollUpVerdict(g, I(a, b, c));
        combos += 1;
        if (v === R) {
          assert.equal(g, R, `READY needs geometry READY (${g})`);
          assert.deepEqual([a, b, c], ['PASS', 'PASS', 'PASS'], `READY needs every finding PASS (${a},${b},${c})`);
        }
        if (g === R && [a, b, c].every((s) => s === 'PASS')) assert.equal(v, R);
        if ([a, b, c].includes('FAIL')) assert.equal(v, NA, 'a blocker is never hidden by PASS results');
        if (![a, b, c].includes('FAIL') && [a, b, c].some((s) => s !== 'PASS')) assert.notEqual(v, R, 'UNKNOWN/WARNING never becomes PASS');
      }
    }
    assert.equal(combos, 7 * 64);
  });

  await runCase('ROLL-UP: missing / malformed integrity input is never READY; a forged impact does not hide a status', async () => {
    for (const bad of [undefined, null, {}, { checks: 'x' }]) {
      assert.notEqual(rollUpVerdict(R, bad), R);
      assert.equal(rollUpVerdict(NA, bad), NA);
    }
    assert.equal(rollUpVerdict(R, { checks: [{ id: 'X', status: 'UNKNOWN', impact: 'NONE' }] }), M, 'status UNKNOWN is manual even if impact says NONE');
    assert.equal(rollUpVerdict(R, { checks: [{ id: 'X', status: 'WARNING', impact: 'NONE' }] }), M);
  });

  // =========================================================================
  // 12. integration through the real runPreflight
  // =========================================================================
  const U_ = { userIntent: U };

  await runCase('INTEGRATION: a clean book is READY; geometryVerdict and an all-PASS integrity block are exposed', async () => {
    const r = await runPreflight(await build(), U_);
    assert.equal(r.verdict, 'READY');
    assert.equal(r.geometryVerdict, 'READY');
    assert.equal(r.integrity.summary.passed, 11);
    assert.equal(r.integrity.impact, 'NONE');
  });

  await runCase('INTEGRATION: geometry READY + Phase 2A blocker -> NEEDS_ATTENTION (geometryVerdict stays READY)', async () => {
    const r = await runPreflight(await build({ setup: (p, i, d) => i === 3 && addAnnots(p, d, { Subtype: 'Text' }) }), U_);
    assert.equal(r.geometryVerdict, 'READY');
    assert.equal(r.verdict, 'NEEDS_ATTENTION');
    assert.equal(r.integrity.impact, 'BLOCKING');
  });

  await runCase('INTEGRATION: geometry READY + a manual-review finding (Link) -> MANUAL_REVIEW_REQUIRED', async () => {
    const r = await runPreflight(await build({ setup: (p, i, d) => i === 0 && addAnnots(p, d, { Subtype: 'Link' }) }), U_);
    assert.equal(r.geometryVerdict, 'READY');
    assert.equal(r.verdict, 'MANUAL_REVIEW_REQUIRED');
  });

  await runCase('INTEGRATION: non-embedded fonts block an otherwise perfect geometry', async () => {
    const r = await runPreflight(await build({ font: false, setup: async (p, i, d) => p.drawText('x', { x: 100, y: 300, size: 12, font: await d.embedFont(StandardFonts.Helvetica) }) }), U_);
    assert.equal(r.geometryVerdict, 'READY');
    assert.equal(r.verdict, 'NEEDS_ATTENTION');
    assert.equal(find(r, 'FONTS_EMBEDDED').status, 'FAIL');
  });

  await runCase('INTEGRATION: geometry MANUAL (no TrimBox) + Phase 2A all PASS -> MANUAL; Phase 2A does not "rescue" it', async () => {
    const r = await runPreflight(await build({ trim: false }), U_);
    assert.equal(r.geometryVerdict, 'MANUAL_REVIEW_REQUIRED');
    assert.equal(r.integrity.impact, 'NONE');
    assert.equal(r.verdict, 'MANUAL_REVIEW_REQUIRED');
  });

  await runCase('INTEGRATION: geometry NEEDS_ATTENTION + all PASS -> NEEDS_ATTENTION; + manual finding -> still NEEDS_ATTENTION', async () => {
    const over = (extra) => build({ setup: (p, i, d) => { if (i === 0) { p.pushOperators(...rectOps(100, 300, 100, 334)); if (extra) extra(p, d); } } });
    const a = await runPreflight(await over(), U_);
    assert.equal(a.geometryVerdict, 'NEEDS_ATTENTION');
    assert.equal(a.verdict, 'NEEDS_ATTENTION');
    const b = await runPreflight(await over((p, d) => addAnnots(p, d, { Subtype: 'Link' })), U_);
    assert.equal(b.verdict, 'NEEDS_ATTENTION');
    assert.equal(find(b, 'LINK_ANNOTATIONS').status, 'WARNING');
  });

  await runCase('INTEGRATION: geometry MANUAL + a Phase 2A blocker -> NEEDS_ATTENTION (documented precedence), both lists intact', async () => {
    const r = await runPreflight(await build({ trim: false, setup: (p, i, d) => i === 0 && addAnnots(p, d, { Subtype: 'Text' }) }), U_);
    assert.equal(r.geometryVerdict, 'MANUAL_REVIEW_REQUIRED');
    assert.equal(r.verdict, 'NEEDS_ATTENTION');
    assert.ok(r.categories.margins.manualReview.length > 0, 'the geometry manual-review items are still reported');
  });

  await runCase('INTEGRATION: UNKNOWN is never PASS end-to-end (tiling pattern -> IMAGE_DPI UNKNOWN -> MANUAL)', async () => {
    const bytes = await build({
      setup: (p, i, doc) => {
        if (i !== 0) return;
        const pat = doc.context.register(doc.context.stream('', { Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 1, 1], XStep: 1, YStep: 1, Resources: {} }));
        p.node.Resources().set(N('Pattern'), doc.context.obj({ P1: pat }));
      },
    });
    const r = await runPreflight(bytes, U_);
    assert.equal(find(r, 'IMAGE_DPI').status, 'UNKNOWN');
    assert.equal(r.geometryVerdict, 'READY');
    assert.equal(r.verdict, 'MANUAL_REVIEW_REQUIRED');
  });

  await runCase('INTEGRATION: several simultaneous findings are all reported; blockers are not hidden by PASS results', async () => {
    const png = imageXObject;
    const bytes = await build({
      font: false,
      setup: async (p, i, doc) => {
        if (i === 0) {
          const hv = await doc.embedFont(StandardFonts.Helvetica);
          p.drawText('x', { x: 100, y: 300, size: 12, font: hv });
          addAnnots(p, doc, { Subtype: 'Text' }, { Subtype: 'Link' });
          setContent(doc, p, `${Buffer.from(p.node.Contents().getContents ? p.node.Contents().getContents() : '').toString('latin1')}`, {});
        }
      },
    });
    void bytes;
    void png;
    const multi = await build({
      setup: async (p, i, doc, f) => {
        if (i === 0) {
          addAnnots(p, doc, { Subtype: 'Text' }, { Subtype: 'Link' });
          const hv = await doc.embedFont(StandardFonts.Helvetica);
          p.drawText('y', { x: 100, y: 320, size: 12, font: hv });
          p.drawImage(await doc.embedPng(zlibPng(60, 60)), { x: 100, y: 400, width: 72, height: 72 }); // 60 px over 1 in = 60 dpi
        }
        if (i === 1) {
          const root = doc.context.nextRef();
          const item = doc.context.register(doc.context.obj({ Title: PDFString.of('Chapter'), Parent: root }));
          doc.context.assign(root, doc.context.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }));
          doc.catalog.set(N('Outlines'), root);
        }
        void f;
      },
    });
    const r = await runPreflight(multi, U_);
    assert.equal(r.geometryVerdict, 'READY');
    assert.equal(r.verdict, 'NEEDS_ATTENTION');
    const status = Object.fromEntries(r.integrity.checks.map((c) => [c.id, c.status]));
    assert.equal(status.BOOKMARKS, 'FAIL');
    assert.equal(status.ANNOTATIONS_COMMENTS, 'FAIL');
    assert.equal(status.FONTS_EMBEDDED, 'FAIL');
    assert.equal(status.LINK_ANNOTATIONS, 'WARNING');
    assert.equal(status.IMAGE_DPI, 'WARNING');
    assert.equal(status.SECURITY_ENCRYPTION, 'PASS');
    assert.equal(status.FILE_SIZE, 'PASS');
    assert.equal(r.integrity.summary.blocking, 3);
    assert.equal(r.integrity.summary.warning, 2);
  });

  await runCase('INTEGRATION: the integrity layer does not touch the geometry result (violations, categories, geometry identical with and without a Link)', async () => {
    const base = await runPreflight(await build({ setup: (p, i) => i === 0 && p.pushOperators(...rectOps(100, 300, 100, 334)) }), U_);
    const linked = await runPreflight(await build({ setup: (p, i, d) => { if (i === 0) { p.pushOperators(...rectOps(100, 300, 100, 334)); addAnnots(p, d, { Subtype: 'Link' }); } } }), U_);
    assert.deepEqual(linked.violations, base.violations);
    assert.deepEqual(linked.categories, base.categories);
    assert.deepEqual(linked.geometry, base.geometry);
    assert.deepEqual(linked.autofixPlans, base.autofixPlans);
    assert.equal(linked.geometryVerdict, base.geometryVerdict);
    assert.notEqual(linked.verdict, base.verdict === 'NEEDS_ATTENTION' ? 'READY' : '');
  });

  await runCase('INTEGRATION: a real encrypted PDF (empty user password) -> geometry is still evaluated; encryption blocks -> NEEDS_ATTENTION', async () => {
    const enc = await encryptPdf(await build({ font: false }));
    const r = await runPreflight(enc, U_);
    assert.equal(find(r, 'SECURITY_ENCRYPTION').status, 'FAIL');
    assert.equal(r.verdict, 'NEEDS_ATTENTION');
    assert.equal(r.geometryVerdict, 'READY', 'pdf.js decrypts it, so the margins were evaluated');
    assert.equal(find(r, 'IMAGE_DPI').status, 'UNKNOWN', 'encrypted content streams are not inspected');
  });

  await runCase('INTEGRATION: a PDF that needs a USER password cannot even be opened by the geometry preflight -> still reported (NEEDS_ATTENTION), geometry unavailable, never READY', async () => {
    const locked = await encryptPdf(await build({ font: false }), { userPassword: 'secret' });
    const r = await runPreflight(locked, U_);
    assert.equal(r.verdict, 'NEEDS_ATTENTION');
    assert.equal(find(r, 'SECURITY_ENCRYPTION').status, 'FAIL');
    assert.equal(r.geometry.status, 'unavailable');
    assert.equal(r.geometryVerdict, 'MANUAL_REVIEW_REQUIRED');
    assert.equal(r.document.pageCount, 30);
    assert.ok(r.categories.margins.diagnostics.some((d) => d.code === 'GEOMETRY_NOT_EVALUATED_LOCKED_PDF'));
  });

  await runCase('INTEGRATION: a corrupt, UNencrypted PDF still throws from the geometry preflight (not swallowed as a verdict)', async () => {
    await assert.rejects(() => runPreflight(new Uint8Array(Buffer.from('%PDF-1.4\nnot a pdf')), U_));
  });

  await runCase('INTEGRATION: autofix cannot reach VERIFIED while a Phase 2A blocker remains (the AFTER verdict is the unified one)', async () => {
    const bytes = await build({ setup: (p, i, d) => { if (i === 0) { p.pushOperators(...rectOps(100, 300, 100, 334)); addAnnots(p, d, { Subtype: 'Text' }); } } });
    const f = await verifyAutofix(bytes, U_);
    assert.equal(f.before.geometryVerdict, 'NEEDS_ATTENTION');
    assert.equal(f.applied.length, 1);
    assert.equal(f.after.geometryVerdict, 'READY', 'the geometry fix itself worked');
    assert.equal(f.after.verdict, 'NEEDS_ATTENTION', 'the annotation blocker remains');
    assert.notEqual(f.verification, 'VERIFIED');
    assert.ok(f.reasons.includes('MANUAL_REVIEW_REMAINS'));
  });

  await runCase('INTEGRATION: a clean READY book keeps the 5F contract (VERIFIED, after:null)', async () => {
    const f = await verifyAutofix(await build(), U_);
    assert.equal(f.verification, 'VERIFIED');
    assert.equal(f.after, null);
  });

  console.log(`\nintegrity.test.js: ${n} cases passed`);
}

/** Tiny valid RGB PNG for pdf-lib's embedPng. */
function zlibPng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, i) => {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 128)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
