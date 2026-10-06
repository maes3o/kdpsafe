'use strict';

/**
 * Phase 2A v1 -- READ-ONLY PDF submission-integrity checks.
 *
 * This module only INSPECTS. It never writes, removes, flattens, embeds,
 * resamples or rewrites anything. It complements (never replaces) the
 * geometry preflight in lib/orchestrator.js: runPreflight() calls
 * runIntegrityChecks() and folds the result into the one authoritative
 * verdict with rollUpVerdict().
 *
 * ---------------------------------------------------------------------------
 * CONTRACT
 *
 *   runIntegrityChecks(pdfBytes, { userIntent, fileSize }) -> {
 *     version: 1,
 *     checks: Finding[],            // exactly one Finding per check, fixed order
 *     summary: { total, passed, blocking, manualReview, unknown, warning },
 *     impact: 'BLOCKING' | 'MANUAL_REVIEW' | 'NONE',
 *   }
 *
 *   Finding = {
 *     id:        'SECURITY_ENCRYPTION' | 'BOOKMARKS' | ...   (see CHECK_IDS)
 *     category:  'security' | 'structure' | 'annotations' | 'file' | 'fonts' |
 *                'signatures' | 'forms' | 'links' | 'images' | 'page-layout'
 *     status:    'PASS' | 'FAIL' | 'WARNING' | 'UNKNOWN'
 *     impact:    'NONE' | 'BLOCKING' | 'MANUAL_REVIEW'      (derived from status)
 *     code:      machine reason, e.g. 'ENCRYPTED', 'NOT_EMBEDDED', 'CHECK_FAILED'
 *     message:   short English summary (the UI localizes by id + code)
 *     details:   check-specific structured data (counts, items)
 *     pages?:    1-based page numbers (capped)
 *     objects?:  small list of offending objects (capped)
 *     evidence?: what was actually found in the PDF
 *     diagnostics?: [{ code, message }]   (only when something prevented a reliable answer)
 *   }
 *
 * STATUS -> VERDICT
 *   FAIL     deterministic, documented requirement violated      -> BLOCKING
 *   WARNING  something was detected but its outcome cannot be
 *            decided from the PDF alone (manual review)           -> MANUAL_REVIEW
 *   UNKNOWN  the check could not be evaluated reliably            -> MANUAL_REVIEW
 *   PASS     evaluated reliably and nothing to report             -> NONE
 * A check that cannot be proven NEVER returns PASS (fail closed). Every check
 * runs in isolation: an exception or an unreadable structure in one check
 * becomes UNKNOWN for that check only.
 *
 * ROLL-UP (rollUpVerdict): geometry NEEDS_ATTENTION or any BLOCKING ->
 * NEEDS_ATTENTION; else geometry MANUAL or any MANUAL_REVIEW -> MANUAL; else
 * READY only if geometry itself is READY. Phase 2A can never produce READY.
 * ---------------------------------------------------------------------------
 */

const {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFRawStream,
  decodePDFRawStream,
} = require('pdf-lib');
const { tokenize } = require('./contentTokenizer');
const { TOLERANCE_PT } = require('./margin');
const { inToPt, BLEED_OUTER_IN, BLEED_INSIDE_IN, BLEED_TOP_IN, BLEED_BOTTOM_IN } = require('./zones');

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const STATUS = { PASS: 'PASS', FAIL: 'FAIL', WARNING: 'WARNING', UNKNOWN: 'UNKNOWN' };
const IMPACT = { NONE: 'NONE', BLOCKING: 'BLOCKING', MANUAL_REVIEW: 'MANUAL_REVIEW' };

const CHECK_IDS = [
  'SECURITY_ENCRYPTION',
  'BOOKMARKS',
  'ANNOTATIONS_COMMENTS',
  'FILE_SIZE',
  'FONTS_EMBEDDED',
  'DIGITAL_SIGNATURES',
  'FORMS_WIDGETS',
  'LINK_ANNOTATIONS',
  'IMAGE_DPI',
  'SPREADS',
  'ORIENTATION',
];

/** KDP states a 650 MB limit without saying MB or MiB. A file is only a proven
 * pass at or below the smaller reading and a proven fail above the larger one;
 * in between the outcome is ambiguous (UNKNOWN), never silently decided. */
const SIZE_LIMIT_MB_DECIMAL = 650 * 1000 * 1000;
const SIZE_LIMIT_MB_BINARY = 650 * 1024 * 1024;

/** Reference value from the KDP image guidance; a rounding allowance of half a
 * dpi absorbs float noise in the effective-resolution arithmetic. It is NOT a
 * second policy threshold. */
const KDP_IMAGE_DPI = 300;
const DPI_ROUNDING_ALLOWANCE = 0.5;

/** Page-dimension comparison tolerance for spread / orientation analysis. */
const PAGE_TOLERANCE_PT = 1;

const CAP_PAGES = 200;
const CAP_OBJECTS = 25;
const MAX_DEPTH = 8;
const MAX_OUTLINE_ITEMS = 200000;

/** Markup annotations that are "comments" in the KDP sense. Subtypes whose
 * policy is not established here (Stamp, FileAttachment, Sound, Redact, media,
 * PrinterMark, TrapNet, Watermark, unknown) are reported for MANUAL review. */
const COMMENT_SUBTYPES = new Set([
  'Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine',
  'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Caret', 'Ink', 'Popup',
]);

const STANDARD_14 = new Set([
  'times-roman', 'times-bold', 'times-italic', 'times-bolditalic',
  'helvetica', 'helvetica-bold', 'helvetica-oblique', 'helvetica-boldoblique',
  'courier', 'courier-bold', 'courier-oblique', 'courier-boldoblique',
  'symbol', 'zapfdingbats',
]);
const STANDARD_ALIAS_PREFIXES = ['arial', 'timesnewroman', 'couriernew', 'helvetica', 'times', 'courier', 'symbol', 'zapfdingbats'];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const N = (s) => PDFName.of(s);

function impactOf(status) {
  if (status === STATUS.FAIL) return IMPACT.BLOCKING;
  if (status === STATUS.WARNING || status === STATUS.UNKNOWN) return IMPACT.MANUAL_REVIEW;
  return IMPACT.NONE;
}

function finding(id, category, status, code, message, extra = {}) {
  return { id, category, status, impact: impactOf(status), code, message, details: {}, ...extra };
}

const uniqSorted = (arr) => [...new Set(arr)].sort((a, b) => a - b);
const capPages = (arr) => uniqSorted(arr).slice(0, CAP_PAGES);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** dict.lookup that tolerates a missing key but never swallows a type mismatch silently. */
function lookupAs(dict, key, Type) {
  if (!dict || typeof dict.lookup !== 'function') return undefined;
  const v = dict.lookup(N(key));
  if (v === undefined) return undefined;
  if (Type && !(v instanceof Type)) throw new Error(`/${key} is not a ${Type.name}`);
  return v;
}
const numberOf = (obj) => (obj instanceof PDFNumber ? obj.asNumber() : undefined);

function nameOf(obj) {
  return obj instanceof PDFName ? obj.decodeText() : undefined;
}

function mul(A, B) {
  return [
    A[0] * B[0] + A[1] * B[2],
    A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2],
    A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4],
    A[4] * B[1] + A[5] * B[3] + B[5],
  ];
}
const IDENTITY = [1, 0, 0, 1, 0, 0];

function decodedBytes(stream) {
  if (typeof stream.getContents !== 'function') throw new Error('stream has no contents');
  // Raw (parsed) streams are decoded through their /Filter chain.
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  return stream.getContents();
}

// ---------------------------------------------------------------------------
// shared inspection context (one load, memoized derived data)
// ---------------------------------------------------------------------------

async function buildContext(pdfBytes, opts) {
  const ctx = {
    bytes: pdfBytes,
    fileSize: Number.isFinite(opts.fileSize) ? opts.fileSize : pdfBytes ? pdfBytes.length : NaN,
    userIntent: opts.userIntent || {},
    doc: null,
    loadError: null,
    encrypted: false,
    _annots: undefined,
  };
  try {
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
    // pdf-lib is lenient: garbage can "load" as an empty document. A document with no
    // readable pages was not actually inspected, so nothing may be concluded from it.
    if (doc.getPageCount() < 1) throw new Error('the file contains no readable pages');
    ctx.doc = doc;
    ctx.encrypted = doc.isEncrypted === true;
  } catch (err) {
    ctx.loadError = errText(err);
  }
  return ctx;
}

function needDoc(ctx) {
  if (!ctx.doc) {
    const e = new Error(`PDF structure could not be read: ${ctx.loadError || 'unknown error'}`);
    e.code = 'LOAD_FAILED';
    throw e;
  }
  return ctx.doc;
}

/** One pass over every page's /Annots; shared by the annotation, form and link checks. */
function collectAnnotations(ctx) {
  if (ctx._annots) return ctx._annots;
  const doc = needDoc(ctx);
  const items = [];
  let unreadable = 0;
  const unreadablePages = [];
  doc.getPages().forEach((page, pageIndex) => {
    let arr;
    try {
      arr = page.node.Annots();
    } catch {
      unreadable += 1;
      unreadablePages.push(pageIndex + 1);
      return;
    }
    if (!arr) return;
    for (let i = 0; i < arr.size(); i++) {
      try {
        const d = doc.context.lookupMaybe(arr.get(i), PDFDict);
        const subtype = d ? nameOf(d.lookup(N('Subtype'))) : undefined;
        if (!d || !subtype) {
          unreadable += 1;
          unreadablePages.push(pageIndex + 1);
          continue;
        }
        const flags = numberOf(d.lookup(N('F'))) || 0;
        let action;
        if (subtype === 'Link') {
          const a = d.lookup(N('A'));
          action = a instanceof PDFDict ? nameOf(a.lookup(N('S'))) || 'unknown' : d.has(N('Dest')) ? 'Dest' : 'none';
        }
        let fieldType;
        if (subtype === 'Widget') fieldType = nameOf(d.lookup(N('FT')));
        items.push({ page: pageIndex + 1, subtype, flags, action, fieldType });
      } catch {
        unreadable += 1;
        unreadablePages.push(pageIndex + 1);
      }
    }
  });
  ctx._annots = { items, unreadable, unreadablePages };
  return ctx._annots;
}

function countBy(items, key) {
  const out = {};
  for (const it of items) out[it[key] || 'unknown'] = (out[it[key] || 'unknown'] || 0) + 1;
  return out;
}

/** Effective page size in points: MediaBox ∩ CropBox, swapped for /Rotate 90/270. */
function effectivePageSizes(ctx) {
  const doc = needDoc(ctx);
  return doc.getPages().map((page, i) => {
    const m = page.getMediaBox();
    let x1 = m.x;
    let y1 = m.y;
    let x2 = m.x + m.width;
    let y2 = m.y + m.height;
    if (page.node.CropBox() !== undefined) {
      const c = page.getCropBox();
      x1 = Math.max(x1, c.x);
      y1 = Math.max(y1, c.y);
      x2 = Math.min(x2, c.x + c.width);
      y2 = Math.min(y2, c.y + c.height);
    }
    let w = x2 - x1;
    let h = y2 - y1;
    const rot = page.getRotation();
    const angle = rot ? ((Math.round(rot.angle) % 360) + 360) % 360 : 0;
    if (angle === 90 || angle === 270) [w, h] = [h, w];
    if (!(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)) {
      throw new Error(`page ${i + 1} has no readable page size`);
    }
    return { page: i + 1, widthPt: w, heightPt: h, rotated: angle !== 0 };
  });
}

const near = (a, b, eps = PAGE_TOLERANCE_PT) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// 1. SECURITY / ENCRYPTION  (documented KDP requirement -> FAIL)
// ---------------------------------------------------------------------------

function checkEncryption(ctx) {
  const doc = needDoc(ctx);
  if (doc.isEncrypted === true) {
    return finding('SECURITY_ENCRYPTION', 'security', STATUS.FAIL, 'ENCRYPTED', 'The PDF is encrypted / security-locked.', {
      details: {},
      evidence: { encryptDictionaryPresent: true },
    });
  }
  return finding('SECURITY_ENCRYPTION', 'security', STATUS.PASS, 'NOT_ENCRYPTED', 'No encryption dictionary found.', {
    evidence: { encryptDictionaryPresent: false },
  });
}

// ---------------------------------------------------------------------------
// 2. BOOKMARKS  (documented KDP requirement -> FAIL)
// ---------------------------------------------------------------------------

function checkBookmarks(ctx) {
  const doc = needDoc(ctx);
  const raw = doc.catalog.get(N('Outlines'));
  if (raw === undefined) {
    return finding('BOOKMARKS', 'structure', STATUS.PASS, 'NONE', 'No bookmark (outline) structure found.');
  }
  const outlines = doc.catalog.lookup(N('Outlines'));
  if (!(outlines instanceof PDFDict)) {
    return finding('BOOKMARKS', 'structure', STATUS.UNKNOWN, 'OUTLINES_UNREADABLE', 'The /Outlines entry could not be read.', {
      diagnostics: [{ code: 'OUTLINES_NOT_A_DICTIONARY', message: '/Outlines is not a dictionary.' }],
    });
  }
  const first = outlines.get(N('First'));
  const count = numberOf(outlines.lookup(N('Count')));
  if (first === undefined) {
    if (count !== undefined && count !== 0) {
      return finding('BOOKMARKS', 'structure', STATUS.UNKNOWN, 'OUTLINES_INCONSISTENT', '/Outlines declares items but has no /First.', {
        evidence: { count },
        diagnostics: [{ code: 'OUTLINES_COUNT_WITHOUT_FIRST', message: `/Count is ${count} but there is no /First.` }],
      });
    }
    return finding('BOOKMARKS', 'structure', STATUS.PASS, 'EMPTY_OUTLINES', 'An empty /Outlines dictionary exists but it contains no bookmarks.', {
      evidence: { items: 0 },
    });
  }
  // Count bookmark items (iterative; cycle- and size-guarded).
  const seen = new Set();
  const stack = [first];
  let items = 0;
  let truncated = false;
  while (stack.length > 0) {
    const ref = stack.pop();
    if (ref instanceof PDFRef) {
      if (seen.has(ref.tag)) continue;
      seen.add(ref.tag);
    }
    const item = doc.context.lookup(ref);
    if (!(item instanceof PDFDict)) continue;
    items += 1;
    if (items >= MAX_OUTLINE_ITEMS) {
      truncated = true;
      break;
    }
    const next = item.get(N('Next'));
    const child = item.get(N('First'));
    if (next !== undefined) stack.push(next);
    if (child !== undefined) stack.push(child);
  }
  return finding('BOOKMARKS', 'structure', STATUS.FAIL, 'BOOKMARKS_PRESENT', 'The PDF contains bookmarks.', {
    details: { items },
    evidence: { items, truncated },
  });
}

// ---------------------------------------------------------------------------
// 3. ANNOTATIONS / COMMENTS  (documented -> FAIL for comment subtypes;
//    other subtypes whose policy is not established -> WARNING)
// ---------------------------------------------------------------------------

function checkAnnotations(ctx) {
  const a = collectAnnotations(ctx);
  const comments = a.items.filter((x) => COMMENT_SUBTYPES.has(x.subtype));
  const other = a.items.filter((x) => !COMMENT_SUBTYPES.has(x.subtype) && x.subtype !== 'Link' && x.subtype !== 'Widget');
  const evidence = {
    commentSubtypes: countBy(comments, 'subtype'),
    otherSubtypes: countBy(other, 'subtype'),
    unreadable: a.unreadable,
  };
  if (comments.length > 0) {
    return finding('ANNOTATIONS_COMMENTS', 'annotations', STATUS.FAIL, 'COMMENTS_PRESENT', 'Comment / markup annotations are present.', {
      details: { comments: comments.length, other: other.length },
      pages: capPages(comments.map((x) => x.page)),
      evidence,
    });
  }
  if (a.unreadable > 0) {
    return finding('ANNOTATIONS_COMMENTS', 'annotations', STATUS.UNKNOWN, 'ANNOTATIONS_UNREADABLE', 'Some annotations could not be read.', {
      details: { other: other.length },
      pages: capPages([...a.unreadablePages, ...other.map((x) => x.page)]),
      evidence,
      diagnostics: [{ code: 'ANNOTATION_UNREADABLE', message: `${a.unreadable} annotation entr${a.unreadable === 1 ? 'y' : 'ies'} could not be read.` }],
    });
  }
  if (other.length > 0) {
    return finding('ANNOTATIONS_COMMENTS', 'annotations', STATUS.WARNING, 'OTHER_ANNOTATION_TYPES', 'Annotations of other types were detected; their KDP handling is not established.', {
      details: { other: other.length },
      pages: capPages(other.map((x) => x.page)),
      evidence,
    });
  }
  return finding('ANNOTATIONS_COMMENTS', 'annotations', STATUS.PASS, 'NONE', 'No comment or markup annotations found.', { evidence });
}

// ---------------------------------------------------------------------------
// 4. FILE SIZE  (documented 650 MB limit)
// ---------------------------------------------------------------------------

function evaluateFileSize(sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return { status: STATUS.UNKNOWN, code: 'SIZE_UNAVAILABLE' };
  if (sizeBytes <= SIZE_LIMIT_MB_DECIMAL) return { status: STATUS.PASS, code: 'WITHIN_LIMIT' };
  if (sizeBytes > SIZE_LIMIT_MB_BINARY) return { status: STATUS.FAIL, code: 'OVER_LIMIT' };
  return { status: STATUS.UNKNOWN, code: 'SIZE_AMBIGUOUS' };
}

function checkFileSize(ctx) {
  const r = evaluateFileSize(ctx.fileSize);
  const messages = {
    WITHIN_LIMIT: 'The file is within 650 MB.',
    OVER_LIMIT: 'The file is larger than 650 MB.',
    SIZE_AMBIGUOUS: 'The file size is between 650 MB (decimal) and 650 MiB; the limit is ambiguous.',
    SIZE_UNAVAILABLE: 'The file size could not be determined.',
  };
  return finding('FILE_SIZE', 'file', r.status, r.code, messages[r.code], {
    details: { sizeBytes: ctx.fileSize, limitDecimalBytes: SIZE_LIMIT_MB_DECIMAL, limitBinaryBytes: SIZE_LIMIT_MB_BINARY },
    evidence: { sizeBytes: ctx.fileSize },
  });
}

// ---------------------------------------------------------------------------
// 5. FONTS  (documented: fonts must be embedded)
// ---------------------------------------------------------------------------

function stripSubset(baseFont) {
  return /^[A-Z]{6}\+/.test(baseFont || '') ? baseFont.slice(7) : baseFont || '';
}

function looksLikeStandardFont(baseFont) {
  const n = stripSubset(baseFont).toLowerCase().replace(/[\s,_]/g, '');
  if (STANDARD_14.has(n)) return true;
  const compact = n.replace(/-/g, '');
  return STANDARD_ALIAS_PREFIXES.some((p) => compact.startsWith(p));
}

/** Returns { embedded: true|false|null, subset, baseFont, subtype, reason }. */
function classifyFont(doc, fontDict) {
  const subtype = nameOf(fontDict.lookup(N('Subtype')));
  const baseFontRaw = nameOf(fontDict.lookup(N('BaseFont')));
  const baseFont = baseFontRaw || '';
  const subset = /^[A-Z]{6}\+/.test(baseFont);
  const out = { baseFont, subtype: subtype || 'unknown', subset, embedded: null, reason: '' };

  if (subtype === 'Type3') {
    out.embedded = true; // glyphs are content streams inside the PDF
    out.reason = 'Type3 glyph procedures';
    return out;
  }
  let descriptorOwner = fontDict;
  if (subtype === 'Type0') {
    const desc = fontDict.lookup(N('DescendantFonts'));
    const first = desc instanceof PDFArray && desc.size() > 0 ? doc.context.lookup(desc.get(0)) : undefined;
    if (!(first instanceof PDFDict)) {
      out.reason = 'Type0 font without a readable descendant font';
      return out;
    }
    descriptorOwner = first;
  } else if (!['Type1', 'MMType1', 'TrueType'].includes(subtype || '')) {
    out.reason = `unrecognized font subtype ${subtype || '(none)'}`;
    return out;
  }
  const fd = descriptorOwner.lookup(N('FontDescriptor'));
  if (fd instanceof PDFDict) {
    out.embedded = fd.has(N('FontFile')) || fd.has(N('FontFile2')) || fd.has(N('FontFile3'));
    out.reason = out.embedded ? 'font program present' : 'font descriptor without a font file';
    return out;
  }
  if (fd !== undefined) {
    out.reason = 'FontDescriptor is not a dictionary';
    return out;
  }
  if (subtype !== 'Type0' && looksLikeStandardFont(baseFont)) {
    out.embedded = false;
    out.reason = 'standard font without a font descriptor';
    return out;
  }
  out.reason = 'no font descriptor, so embedding cannot be determined';
  return out;
}

function checkFonts(ctx) {
  const doc = needDoc(ctx);
  const pages = doc.getPages();
  const fonts = new Map(); // key -> { info, pages:Set }
  const resFonts = new Map(); // resource-dict ref tag -> Set<fontKey>
  const inProgress = new Set();
  const problems = [];
  let anon = 0;

  const registerFont = (ref, dict) => {
    const key = ref instanceof PDFRef ? `r${ref.tag}` : `d${anon++}`;
    if (!fonts.has(key)) {
      let info;
      try {
        info = classifyFont(doc, dict);
      } catch (err) {
        info = { baseFont: '', subtype: 'unknown', subset: false, embedded: null, reason: errText(err) };
      }
      fonts.set(key, { info, pages: new Set() });
    }
    return key;
  };

  const scan = (resources, depth) => {
    const found = new Set();
    if (!(resources instanceof PDFDict)) return found;
    if (depth > MAX_DEPTH) {
      problems.push({ code: 'RESOURCE_DEPTH_EXCEEDED', message: 'Nested resources are too deep to inspect.' });
      return found;
    }
    const merge = (set) => set.forEach((k) => found.add(k));

    const fontDict = resources.lookup(N('Font'));
    if (fontDict instanceof PDFDict) {
      for (const [, v] of fontDict.entries()) {
        const d = doc.context.lookup(v);
        if (d instanceof PDFDict) {
          const key = registerFont(v, d);
          found.add(key);
          // Type3 fonts carry their own resources (glyph procedures may use fonts/XObjects).
          if (nameOf(d.lookup(N('Subtype'))) === 'Type3') {
            const r3 = d.lookup(N('Resources'));
            if (r3 instanceof PDFDict) merge(scanMemo(d.get(N('Resources')), r3, depth + 1));
          }
        } else {
          problems.push({ code: 'FONT_ENTRY_UNREADABLE', message: 'A /Font resource entry is not a dictionary.' });
        }
      }
    } else if (fontDict !== undefined) {
      problems.push({ code: 'FONT_RESOURCES_UNREADABLE', message: '/Font in a resource dictionary is not a dictionary.' });
    }

    const xobjects = resources.lookup(N('XObject'));
    if (xobjects instanceof PDFDict) {
      for (const [, v] of xobjects.entries()) {
        const x = doc.context.lookup(v);
        if (x instanceof PDFStream && nameOf(x.dict.lookup(N('Subtype'))) === 'Form') {
          const r = x.dict.lookup(N('Resources'));
          if (r instanceof PDFDict) merge(scanMemo(x.dict.get(N('Resources')), r, depth + 1));
        }
      }
    }
    const patterns = resources.lookup(N('Pattern'));
    if (patterns instanceof PDFDict) {
      for (const [, v] of patterns.entries()) {
        const p = doc.context.lookup(v);
        const dict = p instanceof PDFStream ? p.dict : p instanceof PDFDict ? p : undefined;
        const r = dict && dict.lookup(N('Resources'));
        if (r instanceof PDFDict) merge(scanMemo(dict.get(N('Resources')), r, depth + 1));
      }
    }
    const gs = resources.lookup(N('ExtGState'));
    if (gs instanceof PDFDict) {
      for (const [, v] of gs.entries()) {
        const g = doc.context.lookup(v);
        const f = g instanceof PDFDict ? g.lookup(N('Font')) : undefined;
        if (f instanceof PDFArray && f.size() > 0) {
          const fr = f.get(0);
          const fd = doc.context.lookup(fr);
          if (fd instanceof PDFDict) found.add(registerFont(fr, fd));
        }
      }
    }
    return found;
  };

  const scanMemo = (rawRef, dict, depth) => {
    if (rawRef instanceof PDFRef) {
      if (resFonts.has(rawRef.tag)) return resFonts.get(rawRef.tag);
      if (inProgress.has(rawRef.tag)) return new Set(); // cycle
      inProgress.add(rawRef.tag);
      const r = scan(dict, depth);
      inProgress.delete(rawRef.tag);
      resFonts.set(rawRef.tag, r);
      return r;
    }
    return scan(dict, depth);
  };

  pages.forEach((page, i) => {
    try {
      const raw = page.node.get(N('Resources')); // a ref when the page owns an indirect resource dictionary (memoized by tag)
      const res = page.node.Resources();
      const set = scanMemo(raw instanceof PDFRef ? raw : undefined, res, 0);
      set.forEach((k) => fonts.get(k).pages.add(i + 1));
    } catch (err) {
      problems.push({ code: 'PAGE_RESOURCES_UNREADABLE', message: `page ${i + 1}: ${errText(err)}` });
    }
  });

  const all = [...fonts.values()];
  const notEmbedded = all.filter((f) => f.info.embedded === false);
  const undetermined = all.filter((f) => f.info.embedded === null);
  const describe = (f) => ({ font: f.info.baseFont || '(unnamed)', subtype: f.info.subtype, subset: f.info.subset, reason: f.info.reason, pages: capPages([...f.pages]) });
  const evidence = {
    fontCount: all.length,
    embedded: all.filter((f) => f.info.embedded === true).length,
    subsetEmbedded: all.filter((f) => f.info.embedded === true && f.info.subset).length,
    notEmbedded: notEmbedded.length,
    undetermined: undetermined.length,
  };

  if (notEmbedded.length > 0) {
    return finding('FONTS_EMBEDDED', 'fonts', STATUS.FAIL, 'NOT_EMBEDDED', 'Fonts that are not embedded were found.', {
      details: { fonts: notEmbedded.slice(0, CAP_OBJECTS).map(describe), undetermined: undetermined.slice(0, CAP_OBJECTS).map(describe) },
      pages: capPages(notEmbedded.flatMap((f) => [...f.pages])),
      objects: notEmbedded.slice(0, CAP_OBJECTS).map((f) => f.info.baseFont || '(unnamed)'),
      evidence,
      ...(problems.length ? { diagnostics: problems.slice(0, 10) } : {}),
    });
  }
  if (undetermined.length > 0 || problems.length > 0) {
    return finding('FONTS_EMBEDDED', 'fonts', STATUS.UNKNOWN, 'EMBEDDING_UNDETERMINED', 'Font embedding could not be determined reliably.', {
      details: { fonts: undetermined.slice(0, CAP_OBJECTS).map(describe) },
      pages: capPages(undetermined.flatMap((f) => [...f.pages])),
      evidence,
      diagnostics: [
        ...undetermined.slice(0, 10).map((f) => ({ code: 'FONT_UNDETERMINED', message: `${f.info.baseFont || '(unnamed)'}: ${f.info.reason}` })),
        ...problems.slice(0, 10),
      ],
    });
  }
  if (all.length === 0) {
    return finding('FONTS_EMBEDDED', 'fonts', STATUS.PASS, 'NO_FONTS', 'No font resources were found.', { evidence });
  }
  return finding('FONTS_EMBEDDED', 'fonts', STATUS.PASS, 'ALL_EMBEDDED', 'All fonts are embedded.', {
    details: { fonts: all.slice(0, CAP_OBJECTS).map(describe) },
    evidence,
  });
}

// ---------------------------------------------------------------------------
// 6. DIGITAL SIGNATURES  (detected only; KDP position not documented -> WARNING)
// ---------------------------------------------------------------------------

function checkSignatures(ctx) {
  const doc = needDoc(ctx);
  let sigObjects = 0;
  let timestamps = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    if (!dict) continue;
    const type = nameOf(dict.lookup(N('Type')));
    if (type === 'DocTimeStamp') {
      timestamps += 1;
      sigObjects += 1;
    } else if (type === 'Sig' || dict.has(N('ByteRange'))) {
      sigObjects += 1;
    }
  }
  const hasPerms = doc.catalog.has(N('Perms'));
  const acro = doc.catalog.lookup(N('AcroForm'));
  const sigFlags = acro instanceof PDFDict ? numberOf(acro.lookup(N('SigFlags'))) || 0 : 0;
  const evidence = { signatureObjects: sigObjects, documentTimestamps: timestamps, permissionsDictionary: hasPerms, sigFlags };
  if (sigObjects > 0 || hasPerms || (sigFlags & 1) === 1) {
    return finding('DIGITAL_SIGNATURES', 'signatures', STATUS.WARNING, 'SIGNATURE_DETECTED', 'Digital signature structures were detected.', { details: evidence, evidence });
  }
  return finding('DIGITAL_SIGNATURES', 'signatures', STATUS.PASS, 'NONE', 'No digital signature structures found.', { evidence });
}

// ---------------------------------------------------------------------------
// 7. FORMS / WIDGETS  (detected only -> WARNING)
// ---------------------------------------------------------------------------

function countFields(doc, fields) {
  if (!(fields instanceof PDFArray)) return 0;
  const seen = new Set();
  let named = 0;
  const walk = (arr, depth) => {
    if (!(arr instanceof PDFArray) || depth > 16) return;
    for (let i = 0; i < arr.size(); i++) {
      const ref = arr.get(i);
      if (ref instanceof PDFRef) {
        if (seen.has(ref.tag)) continue;
        seen.add(ref.tag);
      }
      const f = doc.context.lookup(ref);
      if (!(f instanceof PDFDict)) continue;
      if (f.has(N('T'))) named += 1; // a field has a partial name; anonymous kids are widgets
      walk(f.lookup(N('Kids')), depth + 1);
    }
  };
  walk(fields, 0);
  return named > 0 ? named : fields.size(); // entries without /T still prove the form is not empty
}

function checkForms(ctx) {
  const doc = needDoc(ctx);
  const a = collectAnnotations(ctx);
  const widgets = a.items.filter((x) => x.subtype === 'Widget');
  const rawAcro = doc.catalog.get(N('AcroForm'));
  let fieldCount = 0;
  let hasXfa = false;
  let acroPresent = false;
  if (rawAcro !== undefined) {
    const acro = doc.catalog.lookup(N('AcroForm'));
    if (!(acro instanceof PDFDict)) {
      return finding('FORMS_WIDGETS', 'forms', STATUS.UNKNOWN, 'ACROFORM_UNREADABLE', 'The /AcroForm entry could not be read.', {
        diagnostics: [{ code: 'ACROFORM_NOT_A_DICTIONARY', message: '/AcroForm is not a dictionary.' }],
      });
    }
    acroPresent = true;
    hasXfa = acro.has(N('XFA'));
    fieldCount = countFields(doc, acro.lookup(N('Fields')));
  }
  const evidence = { acroFormPresent: acroPresent, fields: fieldCount, widgetAnnotations: widgets.length, xfa: hasXfa, widgetFieldTypes: countBy(widgets, 'fieldType') };
  if (fieldCount > 0 || widgets.length > 0 || hasXfa) {
    return finding('FORMS_WIDGETS', 'forms', STATUS.WARNING, 'FORMS_DETECTED', 'Interactive form content was detected.', {
      details: evidence,
      pages: capPages(widgets.map((x) => x.page)),
      evidence,
    });
  }
  return finding('FORMS_WIDGETS', 'forms', STATUS.PASS, acroPresent ? 'EMPTY_ACROFORM' : 'NONE', acroPresent ? 'An /AcroForm exists but contains no fields or widgets.' : 'No form content found.', { evidence });
}

// ---------------------------------------------------------------------------
// 8. LINK ANNOTATIONS  (detected only -> WARNING)
// ---------------------------------------------------------------------------

function checkLinks(ctx) {
  const a = collectAnnotations(ctx);
  const links = a.items.filter((x) => x.subtype === 'Link');
  if (a.unreadable > 0) {
    return finding('LINK_ANNOTATIONS', 'links', STATUS.UNKNOWN, 'ANNOTATIONS_UNREADABLE', 'Some annotations could not be read, so links cannot be ruled out.', {
      details: { links: links.length },
      pages: capPages(a.unreadablePages),
      diagnostics: [{ code: 'ANNOTATION_UNREADABLE', message: `${a.unreadable} annotation entr${a.unreadable === 1 ? 'y' : 'ies'} could not be read.` }],
    });
  }
  if (links.length > 0) {
    const evidence = { links: links.length, actions: countBy(links, 'action') };
    return finding('LINK_ANNOTATIONS', 'links', STATUS.WARNING, 'LINKS_DETECTED', 'Link annotations were detected.', {
      details: evidence,
      pages: capPages(links.map((x) => x.page)),
      evidence,
    });
  }
  return finding('LINK_ANNOTATIONS', 'links', STATUS.PASS, 'NONE', 'No link annotations found.');
}

// ---------------------------------------------------------------------------
// 9. IMAGE DPI  (reported; approximate by nature; never silently READY)
// ---------------------------------------------------------------------------

/** Effective resolution from the pixel size and the CTM that maps the unit square. */
function effectiveDpi(pxW, pxH, ctm, userUnit = 1) {
  const wPt = Math.hypot(ctm[0], ctm[1]) * userUnit;
  const hPt = Math.hypot(ctm[2], ctm[3]) * userUnit;
  if (!(wPt > 1e-9 && hPt > 1e-9) || !(pxW > 0 && pxH > 0)) return null;
  return { dpiX: pxW / (wPt / 72), dpiY: pxH / (hPt / 72) };
}

function inlineImageSize(raw) {
  // The header of "BI ... ID": only the dictionary part is read, never the binary data.
  const head = raw.split(/\bID\b/)[0];
  const w = /\/(?:W|Width)\s+(\d+)/.exec(head);
  const h = /\/(?:H|Height)\s+(\d+)/.exec(head);
  return w && h ? { w: Number(w[1]), h: Number(h[1]) } : null;
}

function pageContentBytes(doc, page) {
  const contents = page.node.Contents();
  if (!contents) return new Uint8Array(0);
  const list = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  const parts = list.map((s) => {
    if (!(s instanceof PDFStream)) throw new Error('a page content entry is not a stream');
    return decodedBytes(s);
  });
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 0x0a;
  }
  // lib/contentTokenizer.js expects a Buffer (it slices tokens with toString('latin1')).
  return Buffer.from(out.buffer, out.byteOffset, out.length);
}

function checkImageDpi(ctx) {
  const doc = needDoc(ctx);
  if (ctx.encrypted) {
    return finding('IMAGE_DPI', 'images', STATUS.UNKNOWN, 'ENCRYPTED_CONTENT', 'Content streams of an encrypted PDF cannot be inspected for image resolution.', {
      diagnostics: [{ code: 'ENCRYPTED_CONTENT', message: 'The PDF is encrypted; image placement cannot be read.' }],
    });
  }
  const placements = []; // { page, name, pxW, pxH, dpiX, dpiY, dpi }
  const unresolved = []; // { page, name, reason }
  let patternsSeen = 0;
  let inlineSeen = 0;

  const scanStream = (bytes, resources, baseCtm, pageNo, userUnit, depth, formStack) => {
    const tokens = tokenize(bytes);
    let ctm = baseCtm.slice();
    const stack = [];
    let operands = [];
    for (const tok of tokens) {
      if (tok.type === 'inlineImage') {
        inlineSeen += 1;
        const size = inlineImageSize(tok.raw || '');
        const d = size && effectiveDpi(size.w, size.h, ctm, userUnit);
        if (d) placements.push({ page: pageNo, name: '(inline)', pxW: size.w, pxH: size.h, ...d, dpi: Math.min(d.dpiX, d.dpiY) });
        else unresolved.push({ page: pageNo, name: '(inline)', reason: 'inline image size or placement not readable' });
        operands = [];
        continue;
      }
      if (tok.type !== 'operator') {
        operands.push(tok);
        continue;
      }
      const op = tok.raw;
      if (op === 'q') stack.push(ctm.slice());
      else if (op === 'Q') {
        if (stack.length > 0) ctm = stack.pop();
      } else if (op === 'cm') {
        const nums = operands.filter((t) => t.type === 'number').map((t) => Number(t.raw));
        if (nums.length === 6 && nums.every(Number.isFinite)) ctm = mul(nums, ctm);
        else unresolved.push({ page: pageNo, name: '(cm)', reason: 'malformed cm operator' });
      } else if (op === 'Do') {
        const nameTok = operands.filter((t) => t.type === 'name').pop();
        const name = nameTok ? nameTok.raw.slice(1) : '';
        const xo = resources instanceof PDFDict ? resources.lookup(N('XObject')) : undefined;
        const ref = xo instanceof PDFDict ? xo.get(N(name)) : undefined;
        const obj = ref === undefined ? undefined : doc.context.lookup(ref);
        if (!(obj instanceof PDFStream)) {
          unresolved.push({ page: pageNo, name, reason: 'XObject not found in resources' });
        } else {
          const sub = nameOf(obj.dict.lookup(N('Subtype')));
          if (sub === 'Image') {
            const pxW = numberOf(obj.dict.lookup(N('Width')));
            const pxH = numberOf(obj.dict.lookup(N('Height')));
            const d = pxW && pxH ? effectiveDpi(pxW, pxH, ctm, userUnit) : null;
            if (d) placements.push({ page: pageNo, name, pxW, pxH, ...d, dpi: Math.min(d.dpiX, d.dpiY) });
            else unresolved.push({ page: pageNo, name, reason: 'image size or placement not readable' });
          } else if (sub === 'Form') {
            const key = ref instanceof PDFRef ? ref.tag : null;
            if (depth >= MAX_DEPTH) unresolved.push({ page: pageNo, name, reason: 'form XObjects nested too deeply' });
            else if (key && formStack.includes(key)) unresolved.push({ page: pageNo, name, reason: 'recursive form XObject' });
            else {
              const matrixArr = obj.dict.lookup(N('Matrix'));
              let fm = IDENTITY;
              if (matrixArr instanceof PDFArray && matrixArr.size() === 6) {
                const m = matrixArr.asArray().map((x) => numberOf(doc.context.lookup(x)));
                if (m.every((v) => Number.isFinite(v))) fm = m;
              }
              const fres = obj.dict.lookup(N('Resources'));
              scanStream(Buffer.from(decodedBytes(obj)), fres instanceof PDFDict ? fres : resources, mul(fm, ctm), pageNo, userUnit, depth + 1, key ? [...formStack, key] : formStack);
            }
          }
        }
      }
      operands = [];
    }
  };

  doc.getPages().forEach((page, i) => {
    const res = page.node.Resources();
    if (res instanceof PDFDict) {
      const pats = res.lookup(N('Pattern'));
      if (pats instanceof PDFDict) {
        for (const [, v] of pats.entries()) {
          const p = doc.context.lookup(v);
          const dict = p instanceof PDFStream ? p.dict : p instanceof PDFDict ? p : undefined;
          if (dict && numberOf(dict.lookup(N('PatternType'))) === 1) patternsSeen += 1;
        }
      }
    }
    const uuObj = page.node.get(N('UserUnit'));
    const uu = uuObj === undefined ? 1 : numberOf(doc.context.lookup(uuObj)) || 1;
    scanStream(pageContentBytes(doc, page), res, IDENTITY, i + 1, uu, 0, []);
  });

  const measured = placements.length;
  const low = placements.filter((p) => p.dpi < KDP_IMAGE_DPI - DPI_ROUNDING_ALLOWANCE);
  const minDpi = measured ? Math.min(...placements.map((p) => p.dpi)) : null;
  const round1 = (n) => Math.round(n * 10) / 10;
  const evidence = { imagePlacements: measured, belowReference: low.length, minEffectiveDpi: minDpi === null ? null : round1(minDpi), referenceDpi: KDP_IMAGE_DPI, inlineImages: inlineSeen, unresolvedPlacements: unresolved.length, tilingPatterns: patternsSeen };
  const asItem = (p) => ({ page: p.page, name: p.name, pixels: `${p.pxW}x${p.pxH}`, effectiveDpi: round1(p.dpi), dpiX: round1(p.dpiX), dpiY: round1(p.dpiY) });
  const diagnostics = [
    ...unresolved.slice(0, 10).map((u) => ({ code: 'IMAGE_UNRESOLVED', message: `page ${u.page} ${u.name}: ${u.reason}` })),
    ...(patternsSeen > 0 ? [{ code: 'TILING_PATTERN_NOT_ANALYSED', message: `${patternsSeen} tiling pattern(s) were not analysed for images.` }] : []),
  ];

  if (low.length > 0) {
    return finding('IMAGE_DPI', 'images', STATUS.WARNING, 'LOW_EFFECTIVE_DPI', 'Images below the 300 dpi reference were found (effective resolution is approximate).', {
      details: { images: low.sort((a, b) => a.dpi - b.dpi).slice(0, CAP_OBJECTS).map(asItem) },
      pages: capPages(low.map((p) => p.page)),
      objects: low.slice(0, CAP_OBJECTS).map((p) => `${p.name} (page ${p.page})`),
      evidence,
      ...(diagnostics.length ? { diagnostics } : {}),
    });
  }
  if (unresolved.length > 0 || patternsSeen > 0) {
    return finding('IMAGE_DPI', 'images', STATUS.UNKNOWN, 'DPI_UNDETERMINED', 'The effective resolution of some images could not be determined.', {
      details: { unresolved: unresolved.slice(0, CAP_OBJECTS) },
      pages: capPages(unresolved.map((u) => u.page)),
      evidence,
      diagnostics,
    });
  }
  if (measured === 0) return finding('IMAGE_DPI', 'images', STATUS.PASS, 'NO_IMAGES', 'No images were found on any page.', { evidence });
  return finding('IMAGE_DPI', 'images', STATUS.PASS, 'ALL_AT_OR_ABOVE_REFERENCE', 'All images are at or above 300 dpi (effective).', { evidence });
}

// ---------------------------------------------------------------------------
// 10. SPREADS / 2-UP  (needs the user's trim context)
// ---------------------------------------------------------------------------

function checkSpreads(ctx) {
  const intent = ctx.userIntent || {};
  const ts = intent.trimSize || {};
  if (!(ts.widthIn > 0 && ts.heightIn > 0) || typeof intent.bleed !== 'boolean') {
    return finding('SPREADS', 'page-layout', STATUS.UNKNOWN, 'TRIM_CONTEXT_MISSING', 'Without a selected trim size and bleed choice, spreads cannot be assessed.', {
      diagnostics: [{ code: 'TRIM_CONTEXT_MISSING', message: 'userIntent.trimSize / bleed is missing.' }],
    });
  }
  const sizes = effectivePageSizes(ctx);
  const bleed = intent.bleed === true;
  const singleW = inToPt(ts.widthIn) + (bleed ? inToPt(BLEED_OUTER_IN + BLEED_INSIDE_IN) : 0);
  const singleH = inToPt(ts.heightIn) + (bleed ? inToPt(BLEED_TOP_IN + BLEED_BOTTOM_IN) : 0);
  const spreadW = 2 * inToPt(ts.widthIn) + (bleed ? 2 * inToPt(BLEED_OUTER_IN) : 0);
  const spreadH = singleH;
  const trimPortrait = ts.heightIn > ts.widthIn;
  const doc = needDoc(ctx);
  const pdfPages = doc.getPages();
  const spreadPages = [];
  const ambiguousPages = [];
  for (const s of sizes) {
    if (near(s.widthPt, singleW) && near(s.heightPt, singleH)) continue; // a single page
    // A page whose explicit TrimBox is already the selected single-page trim is a
    // single page with extra area (slug / marks), not a spread.
    const page = pdfPages[s.page - 1];
    if (page.node.TrimBox() !== undefined) {
      const tb = page.getTrimBox();
      const tw = s.rotated ? tb.height : tb.width;
      const th = s.rotated ? tb.width : tb.height;
      if (near(tw, inToPt(ts.widthIn), PAGE_TOLERANCE_PT) && near(th, inToPt(ts.heightIn), PAGE_TOLERANCE_PT)) continue;
    }
    if (near(s.widthPt, spreadW) && near(s.heightPt, spreadH)) spreadPages.push(s.page);
    else if (trimPortrait && s.widthPt > s.heightPt + PAGE_TOLERANCE_PT) ambiguousPages.push(s.page);
  }
  const evidence = { selectedTrimIn: `${ts.widthIn}x${ts.heightIn}`, bleed, spreadMatches: spreadPages.length, ambiguousLandscape: ambiguousPages.length, pagesChecked: sizes.length };
  if (spreadPages.length > 0) {
    return finding('SPREADS', 'page-layout', STATUS.FAIL, 'SPREAD_DETECTED', 'Pages are exactly twice the selected trim width (a two-page spread).', {
      details: evidence,
      pages: capPages(spreadPages),
      evidence,
    });
  }
  if (ambiguousPages.length > 0) {
    return finding('SPREADS', 'page-layout', STATUS.WARNING, 'AMBIGUOUS_LANDSCAPE', 'Landscape pages were found that could be spreads or wide pages; this cannot be decided from the PDF.', {
      details: evidence,
      pages: capPages(ambiguousPages),
      evidence,
    });
  }
  return finding('SPREADS', 'page-layout', STATUS.PASS, 'NO_SPREAD_INDICATION', 'No page indicates a two-page spread for the selected trim.', { evidence });
}

// ---------------------------------------------------------------------------
// 11. ORIENTATION  (only deterministic information Phase 1 does not give)
// ---------------------------------------------------------------------------

function checkOrientation(ctx) {
  const sizes = effectivePageSizes(ctx);
  // Pages with /Rotate are Phase 1's territory (the geometry preflight already
  // sends them to MANUAL REVIEW). They are neither counted nor contradicted here.
  const rotated = sizes.filter((s) => s.rotated);
  const portrait = [];
  const landscape = [];
  for (const s of sizes) {
    if (s.rotated) continue;
    if (s.heightPt > s.widthPt + PAGE_TOLERANCE_PT) portrait.push(s.page);
    else if (s.widthPt > s.heightPt + PAGE_TOLERANCE_PT) landscape.push(s.page);
  }
  const evidence = {
    portraitPages: portrait.length,
    landscapePages: landscape.length,
    squarePages: sizes.length - rotated.length - portrait.length - landscape.length,
    rotatedPagesNotAssessed: rotated.length,
    pagesChecked: sizes.length,
    basis: 'page size of unrotated pages (MediaBox and CropBox); content orientation is not inspected',
  };
  if (portrait.length > 0 && landscape.length > 0) {
    const minority = portrait.length < landscape.length ? portrait : landscape;
    return finding('ORIENTATION', 'page-layout', STATUS.FAIL, 'MIXED_ORIENTATION', 'Portrait and landscape pages are mixed.', {
      details: evidence,
      pages: capPages(minority),
      evidence,
    });
  }
  if (rotated.length > 0) {
    return finding('ORIENTATION', 'page-layout', STATUS.UNKNOWN, 'ROTATED_PAGES_NOT_ASSESSED', 'Rotated pages (/Rotate) are not assessed for orientation here.', {
      details: evidence,
      pages: capPages(rotated.map((s) => s.page)),
      evidence,
      diagnostics: [{ code: 'ROTATED_PAGES_NOT_ASSESSED', message: 'Page rotation is handled by the geometry preflight; orientation is not decided for rotated pages.' }],
    });
  }
  return finding('ORIENTATION', 'page-layout', STATUS.PASS, 'CONSISTENT', 'All pages share one orientation (by page size; content orientation is not inspected).', { evidence });
}

// ---------------------------------------------------------------------------
// registry + runner
// ---------------------------------------------------------------------------

const CATEGORY_OF = {
  SECURITY_ENCRYPTION: 'security',
  BOOKMARKS: 'structure',
  ANNOTATIONS_COMMENTS: 'annotations',
  FILE_SIZE: 'file',
  FONTS_EMBEDDED: 'fonts',
  DIGITAL_SIGNATURES: 'signatures',
  FORMS_WIDGETS: 'forms',
  LINK_ANNOTATIONS: 'links',
  IMAGE_DPI: 'images',
  SPREADS: 'page-layout',
  ORIENTATION: 'page-layout',
};

const CHECKS = [
  { id: 'SECURITY_ENCRYPTION', run: checkEncryption },
  { id: 'BOOKMARKS', run: checkBookmarks },
  { id: 'ANNOTATIONS_COMMENTS', run: checkAnnotations },
  { id: 'FILE_SIZE', run: checkFileSize },
  { id: 'FONTS_EMBEDDED', run: checkFonts },
  { id: 'DIGITAL_SIGNATURES', run: checkSignatures },
  { id: 'FORMS_WIDGETS', run: checkForms },
  { id: 'LINK_ANNOTATIONS', run: checkLinks },
  { id: 'IMAGE_DPI', run: checkImageDpi },
  { id: 'SPREADS', run: checkSpreads },
  { id: 'ORIENTATION', run: checkOrientation },
];

function unknownFinding(id, err) {
  const loadFailed = err && err.code === 'LOAD_FAILED';
  return finding(id, CATEGORY_OF[id] || 'integrity', STATUS.UNKNOWN, loadFailed ? 'LOAD_FAILED' : 'CHECK_FAILED', loadFailed ? 'The PDF structure could not be read.' : 'The check could not be completed.', {
    diagnostics: [{ code: loadFailed ? 'LOAD_FAILED' : 'CHECK_FAILED', message: errText(err) }],
  });
}

function summarize(checks) {
  const s = { total: checks.length, passed: 0, blocking: 0, warning: 0, unknown: 0, manualReview: 0 };
  for (const c of checks) {
    if (c.status === STATUS.PASS) s.passed += 1;
    else if (c.status === STATUS.FAIL) s.blocking += 1;
    else if (c.status === STATUS.WARNING) s.warning += 1;
    else s.unknown += 1;
    if (c.impact === IMPACT.MANUAL_REVIEW) s.manualReview += 1;
  }
  return s;
}

function overallImpact(checks) {
  if (checks.some((c) => c.impact === IMPACT.BLOCKING)) return IMPACT.BLOCKING;
  if (checks.some((c) => c.impact === IMPACT.MANUAL_REVIEW)) return IMPACT.MANUAL_REVIEW;
  return IMPACT.NONE;
}

/**
 * @param {Uint8Array} pdfBytes
 * @param {{ userIntent?: object, fileSize?: number, checks?: Array<{id:string, run:Function}> }} [opts]
 *        `checks` replaces the registry (tests inject failing checks).
 */
async function runIntegrityChecks(pdfBytes, opts = {}) {
  const ctx = await buildContext(pdfBytes, opts);
  const registry = opts.checks || CHECKS;
  const checks = [];
  for (const { id, run } of registry) {
    try {
      const f = await run(ctx);
      // A check must return a well-formed finding; anything else is not a PASS.
      if (!f || f.id !== id || !STATUS[f.status]) throw new Error('check returned an invalid result');
      checks.push(f);
    } catch (err) {
      checks.push(unknownFinding(id, err));
    }
  }
  return { version: 1, checks, summary: summarize(checks), impact: overallImpact(checks) };
}

/** An integrity result for a run where the inspection itself failed. Never a PASS. */
function failedIntegrity(err) {
  const checks = [
    finding('INTEGRITY_INSPECTION', 'integrity', STATUS.UNKNOWN, 'CHECK_FAILED', 'The integrity inspection could not be completed.', {
      diagnostics: [{ code: 'CHECK_FAILED', message: errText(err) }],
    }),
  ];
  return { version: 1, checks, summary: summarize(checks), impact: IMPACT.MANUAL_REVIEW };
}

/**
 * The single verdict roll-up. Geometry stays authoritative for geometry;
 * Phase 2A can only make the verdict WORSE, never produce READY.
 */
function rollUpVerdict(geometryVerdict, integrity) {
  const checks = integrity && Array.isArray(integrity.checks) ? integrity.checks : null;
  if (!checks) return geometryVerdict === 'NEEDS_ATTENTION' ? 'NEEDS_ATTENTION' : 'MANUAL_REVIEW_REQUIRED'; // no integrity result: never READY
  const blocking = checks.some((c) => c.impact === IMPACT.BLOCKING);
  const manual = checks.some((c) => c.impact === IMPACT.MANUAL_REVIEW || c.status === STATUS.UNKNOWN || c.status === STATUS.WARNING);
  if (geometryVerdict === 'NEEDS_ATTENTION' || blocking) return 'NEEDS_ATTENTION';
  if (geometryVerdict === 'MANUAL_REVIEW_REQUIRED' || manual) return 'MANUAL_REVIEW_REQUIRED';
  return geometryVerdict === 'READY' ? 'READY' : 'MANUAL_REVIEW_REQUIRED';
}

module.exports = {
  runIntegrityChecks,
  failedIntegrity,
  rollUpVerdict,
  evaluateFileSize,
  effectiveDpi,
  CHECKS,
  CHECK_IDS,
  STATUS,
  IMPACT,
  COMMENT_SUBTYPES,
  SIZE_LIMIT_MB_DECIMAL,
  SIZE_LIMIT_MB_BINARY,
  KDP_IMAGE_DPI,
  DPI_ROUNDING_ALLOWANCE,
};
