'use strict';

/**
 * PageGeometryNormalizer -- assessment, planning and (metadata-only) apply
 * for PDF page boxes. Added in page-geometry V2.
 *
 * WHAT THIS MODULE IS
 *   A conservative layer that answers one question the frozen preflight
 *   engine deliberately leaves open: "this PDF has no explicit /TrimBox --
 *   can one be written safely, so the real preflight can run?"
 *
 * WHAT IT IS NOT
 *   - Not a compliance engine. It never decides READY / violations. The
 *     frozen preflight (lib/orchestrator.js runPreflight) stays
 *     authoritative; normalizePageGeometry() just runs it on the output.
 *   - Not a content fixer. It NEVER scales, crops, moves or rotates
 *     content. The only thing it can write is /TrimBox (and, for trim+bleed
 *     pages, /BleedBox). Content streams are byte-identical afterwards, and
 *     that is VERIFIED (see applyNormalization) before any output is
 *     returned.
 *   - No KDP numbers live here: bleed amounts and inside/outside parity
 *     come from lib/zones.js (buildZones), the single source of that policy.
 *
 * TWO DIFFERENT THINGS (kept separate in names and tests):
 *   A. make the PDF's page BOXES conform to the requested geometry
 *      (metadata only; possible when confidence is high);
 *   B. make the CONTENT fit the requested geometry (scaling/cropping/
 *      moving; changes the book; NEVER done here).
 *
 * TIERS (assessment.tier)
 *   0 NONE            every page already has a matching explicit /TrimBox.
 *   1 METADATA_ONLY   page == selected trim, no bleed, no /TrimBox
 *                     -> plan: ADD_TRIM_BOX.
 *   2 CONFIRMED_BLEED page == trim + KDP bleed, reading direction known
 *                     -> plan: DEFINE_TRIM_BOX_FROM_BLEED.
 *   3 SIMILAR_MANUAL  page is close to the target but not equal: fixing it
 *                     would scale/crop/move -> manual, no plan.
 *   4 DIFFERENT_SIZE  a different size (A4 -> 6x9 ...) -> manual, no plan.
 *   5 DO_NOT_TOUCH    encrypted, signed, rotated, mixed, conflicting boxes
 *                     ... -> manual, no plan.
 *
 * KDP NOTE: which page box Amazon KDP itself reads is NOT verified. Nothing
 * here claims KDP acceptance; it only makes the PDF's boxes explicit so
 * KDPSafe's own preflight can evaluate it.
 */

const {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  PDFRef,
} = require('pdf-lib');
const { TOLERANCE_PT } = require('./margin');
const { buildZones, inToPt, BLEED_OUTER_IN, BLEED_INSIDE_IN, BLEED_TOP_IN, BLEED_BOTTOM_IN } = require('./zones');

/** A page "close to but not equal to" the target (Tier 3 explanation only;
 * never enables an automatic repair). */
const SIMILAR_TOLERANCE_PT = 7.2; // 0.1in

const CATEGORY = {
  EXACT_TRIM_PRESENT: 'EXACT_TRIM_PRESENT',
  EXACT_PAGE_NO_TRIM: 'EXACT_PAGE_NO_TRIM',
  EXACT_PAGE_WITH_BLEED: 'EXACT_PAGE_WITH_BLEED',
  SIMILAR_COMPATIBLE: 'SIMILAR_COMPATIBLE',
  DIFFERENT_SIZE: 'DIFFERENT_SIZE',
  ROTATED_UNCERTAIN: 'ROTATED_UNCERTAIN',
  MIXED_DOCUMENT: 'MIXED_DOCUMENT',
  CONFLICTING_BOXES: 'CONFLICTING_BOXES',
  DO_NOT_TOUCH: 'DO_NOT_TOUCH',
};

// ---------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------

const near = (a, b, eps = TOLERANCE_PT) => Math.abs(a - b) <= eps;
const rectOf = (b) => ({ x: b.x, y: b.y, width: b.width, height: b.height });
const sameRect = (a, b, eps = TOLERANCE_PT) =>
  near(a.x, b.x, eps) && near(a.y, b.y, eps) && near(a.width, b.width, eps) && near(a.height, b.height, eps);

function intersect(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

function normalizedRotation(page) {
  const r = page.getRotation();
  return r ? ((Math.round(r.angle) % 360) + 360) % 360 : 0;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Digital-signature evidence: DocMDP (/Perms), AcroForm /SigFlags bit 1, or
 * any signature field with a value. Conservative: any hit = signed. */
function isSigned(doc) {
  const catalog = doc.catalog;
  if (catalog.has(PDFName.of('Perms'))) return true;
  const acro = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acro) return false;
  const flags = acro.lookupMaybe(PDFName.of('SigFlags'), PDFNumber);
  if (flags && (flags.asNumber() & 1) === 1) return true;
  const seen = new Set();
  const walk = (fields, depth) => {
    if (!fields || depth > 8) return false;
    for (let i = 0; i < fields.size(); i++) {
      const ref = fields.get(i);
      if (ref instanceof PDFRef) {
        if (seen.has(ref.tag)) continue;
        seen.add(ref.tag);
      }
      const field = doc.context.lookupMaybe(ref, PDFDict);
      if (!field) continue;
      const ft = field.lookup(PDFName.of('FT'));
      if (ft instanceof PDFName && ft.decodeText() === 'Sig' && field.has(PDFName.of('V'))) return true;
      if (walk(field.lookupMaybe(PDFName.of('Kids'), PDFArray), depth + 1)) return true;
    }
    return false;
  };
  return walk(acro.lookupMaybe(PDFName.of('Fields'), PDFArray), 0);
}

// ---------------------------------------------------------------------
// assessment (pure analysis; never writes)
// ---------------------------------------------------------------------

/**
 * @param {Uint8Array} pdfBytes
 * @param {{trimSize:{widthIn:number,heightIn:number}, bleed:boolean, readingDirection?:'ltr'|'rtl'}} userIntent
 * @returns {Promise<object>} PageGeometryAssessment (see header + frontend/src/engine/types.ts)
 */
async function assessPageGeometry(pdfBytes, userIntent) {
  const intent = userIntent || {};
  const trimSize = intent.trimSize || {};
  const trimWidthPt = inToPt(trimSize.widthIn);
  const trimHeightPt = inToPt(trimSize.heightIn);
  const bleed = intent.bleed === true;
  const readingDirection = intent.readingDirection === 'ltr' || intent.readingDirection === 'rtl' ? intent.readingDirection : null;

  const base = {
    selectedTrim: { widthIn: trimSize.widthIn, heightIn: trimSize.heightIn },
    bleed,
    readingDirection,
    pageCount: 0,
    encrypted: false,
    signed: false,
    pages: [],
    category: CATEGORY.DO_NOT_TOUCH,
    tier: 5,
    reasons: [],
    pageSize: null,
    trimBox: 'missing',
    plan: null,
  };

  let doc;
  try {
    doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (err) {
    return { ...base, reasons: ['LOAD_FAILED'], loadError: err instanceof Error ? err.message : String(err) };
  }

  const pages = doc.getPages();
  base.pageCount = pages.length;
  base.encrypted = doc.isEncrypted === true;
  base.signed = !base.encrypted && isSigned(doc);

  if (!(trimWidthPt > 0 && trimHeightPt > 0)) {
    return { ...base, reasons: ['TRIM_SIZE_MISSING'] };
  }
  if (pages.length === 0) return { ...base, reasons: ['NO_PAGES'] };

  const bleedExtraW = inToPt(BLEED_OUTER_IN + BLEED_INSIDE_IN);
  const bleedExtraH = inToPt(BLEED_TOP_IN + BLEED_BOTTOM_IN);

  const pageAssessments = pages.map((page, pageIndex) => {
    const media = rectOf(page.getMediaBox());
    const cropExplicit = page.node.CropBox() !== undefined;
    const crop = rectOf(page.getCropBox());
    const trimExplicit = page.node.TrimBox() !== undefined;
    const bleedExplicit = page.node.BleedBox() !== undefined;
    const trim = trimExplicit ? rectOf(page.getTrimBox()) : null;
    const bleedBox = bleedExplicit ? rectOf(page.getBleedBox()) : null;
    const rotationDeg = normalizedRotation(page);
    const visible = intersect(crop, media);
    const swap = rotationDeg === 90 || rotationDeg === 270;
    const effective = { widthPt: swap ? visible.height : visible.width, heightPt: swap ? visible.width : visible.height };
    const userUnit = page.node.get(PDFName.of('UserUnit'));

    const reasons = [];
    let category;

    if (userUnit !== undefined) {
      category = CATEGORY.DO_NOT_TOUCH;
      reasons.push('USER_UNIT');
    } else if (rotationDeg !== 0) {
      category = CATEGORY.ROTATED_UNCERTAIN;
      reasons.push('ROTATED_PAGE');
    } else if (trimExplicit) {
      const dimsMatch = near(trim.width, trimWidthPt) && near(trim.height, trimHeightPt);
      if (dimsMatch) category = CATEGORY.EXACT_TRIM_PRESENT;
      else {
        category = CATEGORY.CONFLICTING_BOXES;
        reasons.push('TRIM_BOX_MISMATCH');
      }
    } else if (cropExplicit && !sameRect(crop, media)) {
      category = CATEGORY.CONFLICTING_BOXES;
      reasons.push('CROP_BOX_DIFFERS');
    } else {
      const eqTrim = near(effective.widthPt, trimWidthPt) && near(effective.heightPt, trimHeightPt);
      const eqTrimBleed =
        near(effective.widthPt, trimWidthPt + bleedExtraW) && near(effective.heightPt, trimHeightPt + bleedExtraH);
      if (!bleed && eqTrim) {
        if (bleedExplicit && !sameRect(bleedBox, media)) {
          category = CATEGORY.CONFLICTING_BOXES;
          reasons.push('BLEED_BOX_CONFLICT');
        } else category = CATEGORY.EXACT_PAGE_NO_TRIM;
      } else if (bleed && eqTrimBleed) {
        if (bleedExplicit && !sameRect(bleedBox, media)) {
          category = CATEGORY.CONFLICTING_BOXES;
          reasons.push('BLEED_BOX_CONFLICT');
        } else category = CATEGORY.EXACT_PAGE_WITH_BLEED;
      } else if (bleed && eqTrim) {
        category = CATEGORY.DIFFERENT_SIZE;
        reasons.push('PAGE_IS_TRIM_SIZE_BUT_BLEED_SELECTED');
      } else if (!bleed && eqTrimBleed) {
        category = CATEGORY.DIFFERENT_SIZE;
        reasons.push('PAGE_HAS_BLEED_SIZE_BUT_NO_BLEED_SELECTED');
      } else {
        const targetW = trimWidthPt + (bleed ? bleedExtraW : 0);
        const targetH = trimHeightPt + (bleed ? bleedExtraH : 0);
        const close = near(effective.widthPt, targetW, SIMILAR_TOLERANCE_PT) && near(effective.heightPt, targetH, SIMILAR_TOLERANCE_PT);
        category = close ? CATEGORY.SIMILAR_COMPATIBLE : CATEGORY.DIFFERENT_SIZE;
        reasons.push(close ? 'SIZE_CLOSE_BUT_DIFFERENT' : 'SIZE_DIFFERENT');
      }
    }

    return {
      pageIndex,
      pageNumber: pageIndex + 1,
      parity: (pageIndex + 1) % 2 === 1 ? 'odd' : 'even',
      category,
      reasons,
      rotationDeg,
      effectiveSizePt: effective,
      mediaBox: media,
      cropBox: { explicit: cropExplicit, ...crop },
      trimBox: trim ? { explicit: true, ...trim } : { explicit: false },
      bleedBox: bleedBox ? { explicit: true, ...bleedBox } : { explicit: false },
    };
  });

  // ---- document-level classification --------------------------------
  const first = pageAssessments[0];
  const sizesConsistent = pageAssessments.every(
    (p) =>
      near(p.effectiveSizePt.widthPt, first.effectiveSizePt.widthPt) && near(p.effectiveSizePt.heightPt, first.effectiveSizePt.heightPt)
  );
  const cats = new Set(pageAssessments.map((p) => p.category));
  const reasons = [];
  let category;

  if (base.encrypted || base.signed) {
    category = CATEGORY.DO_NOT_TOUCH;
    reasons.push(base.encrypted ? 'ENCRYPTED' : 'SIGNED');
  } else if (cats.has(CATEGORY.DO_NOT_TOUCH)) {
    category = CATEGORY.DO_NOT_TOUCH;
    reasons.push(...new Set(pageAssessments.filter((p) => p.category === CATEGORY.DO_NOT_TOUCH).flatMap((p) => p.reasons)));
  } else if (cats.has(CATEGORY.ROTATED_UNCERTAIN)) {
    category = CATEGORY.ROTATED_UNCERTAIN;
    reasons.push('ROTATED_PAGE');
  } else if (cats.has(CATEGORY.CONFLICTING_BOXES)) {
    category = CATEGORY.CONFLICTING_BOXES;
    reasons.push(...new Set(pageAssessments.filter((p) => p.category === CATEGORY.CONFLICTING_BOXES).flatMap((p) => p.reasons)));
  } else if (cats.size > 1 || !sizesConsistent) {
    category = CATEGORY.MIXED_DOCUMENT;
    reasons.push(sizesConsistent ? 'MIXED_PAGE_STATES' : 'MIXED_PAGE_SIZES');
  } else {
    category = first.category;
    reasons.push(...first.reasons);
  }

  const trimStates = new Set(pageAssessments.map((p) => (p.trimBox.explicit ? 'explicit' : 'missing')));
  const out = {
    ...base,
    pages: pageAssessments,
    category,
    reasons,
    pageSize: {
      widthIn: first.effectiveSizePt.widthPt / 72,
      heightIn: first.effectiveSizePt.heightPt / 72,
    },
    trimBox: trimStates.size > 1 ? 'mixed' : [...trimStates][0],
  };

  // ---- tier + plan ---------------------------------------------------
  switch (category) {
    case CATEGORY.EXACT_TRIM_PRESENT:
      out.tier = 0;
      break;
    case CATEGORY.EXACT_PAGE_NO_TRIM:
      out.tier = 1;
      out.plan = {
        kind: 'ADD_TRIM_BOX',
        tier: 1,
        changes: pageAssessments.map((p) => ({
          pageIndex: p.pageIndex,
          before: { trimBox: null, bleedBox: null },
          set: { trimBox: { ...p.mediaBox } },
        })),
        guarantees: { contentStreamsUnchanged: true, scales: false, crops: false, moves: false, rotates: false },
      };
      break;
    case CATEGORY.EXACT_PAGE_WITH_BLEED: {
      out.tier = 2;
      const changes = [];
      let unresolved = false;
      for (const p of pageAssessments) {
        // Parity/inside-outside and the bleed amounts come from lib/zones.js.
        const zones = buildZones({ pageCount: pages.length, pageNumber: p.pageNumber }, { trimSize, bleed: true, readingDirection: readingDirection || undefined });
        const b = zones.bleedBoxPt;
        if (!b || b.minX === null || b.maxX === null || typeof b.minY !== 'number') {
          unresolved = true;
          break;
        }
        // Defensive: the abstract bleed box must have the page's own size.
        if (!near(b.maxX - b.minX, p.mediaBox.width) || !near(b.maxY - b.minY, p.mediaBox.height)) {
          unresolved = true;
          break;
        }
        changes.push({
          pageIndex: p.pageIndex,
          before: { trimBox: null, bleedBox: null },
          set: {
            trimBox: { x: p.mediaBox.x - b.minX, y: p.mediaBox.y - b.minY, width: trimWidthPt, height: trimHeightPt },
            bleedBox: { ...p.mediaBox },
          },
        });
      }
      if (unresolved) {
        out.reasons = [...reasons, readingDirection ? 'BLEED_HORIZONTAL_UNRESOLVED' : 'READING_DIRECTION_REQUIRED'];
      } else {
        out.plan = {
          kind: 'DEFINE_TRIM_BOX_FROM_BLEED',
          tier: 2,
          changes,
          guarantees: { contentStreamsUnchanged: true, scales: false, crops: false, moves: false, rotates: false },
        };
      }
      break;
    }
    case CATEGORY.SIMILAR_COMPATIBLE:
      out.tier = 3;
      break;
    case CATEGORY.DIFFERENT_SIZE:
      out.tier = 4;
      break;
    default:
      out.tier = 5;
  }

  return out;
}

// ---------------------------------------------------------------------
// apply (metadata only) + safety verification
// ---------------------------------------------------------------------

function contentStreamsOf(doc, page) {
  const contents = page.node.Contents();
  if (!contents) return [];
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  return streams.map((s) => (s && typeof s.getContents === 'function' ? new Uint8Array(s.getContents()) : null));
}

function annotsOf(doc, page) {
  const arr = page.node.Annots();
  if (!arr) return [];
  const out = [];
  for (let i = 0; i < arr.size(); i++) {
    const d = doc.context.lookupMaybe(arr.get(i), PDFDict);
    const subtype = d && d.lookup(PDFName.of('Subtype'));
    const rect = d && d.lookup(PDFName.of('Rect'));
    out.push(`${subtype ? subtype.toString() : '?'}|${rect ? rect.toString() : '?'}`);
  }
  return out;
}

function snapshot(doc) {
  const meta = {
    title: doc.getTitle(),
    author: doc.getAuthor(),
    subject: doc.getSubject(),
    keywords: doc.getKeywords(),
    creator: doc.getCreator(),
    producer: doc.getProducer(),
    created: doc.getCreationDate() && doc.getCreationDate().toISOString(),
    modified: doc.getModificationDate() && doc.getModificationDate().toISOString(),
  };
  return {
    pageCount: doc.getPageCount(),
    meta,
    pages: doc.getPages().map((page) => ({
      contents: contentStreamsOf(doc, page),
      annots: annotsOf(doc, page),
      media: rectOf(page.getMediaBox()),
      cropExplicit: page.node.CropBox() !== undefined,
      crop: rectOf(page.getCropBox()),
      rotation: normalizedRotation(page),
      trimExplicit: page.node.TrimBox() !== undefined,
      trim: rectOf(page.getTrimBox()),
      bleedExplicit: page.node.BleedBox() !== undefined,
      bleed: rectOf(page.getBleedBox()),
      artExplicit: page.node.ArtBox() !== undefined,
      art: rectOf(page.getArtBox()),
    })),
  };
}

/**
 * Applies an approved plan (page boxes ONLY) and proves, on the SAVED bytes,
 * that nothing else changed. Never throws for safety failures: on any
 * failed check it returns { ok:false, outputBytes:null } so the caller keeps
 * the original bytes.
 *
 * Checks: page count; every content stream byte-identical; annotations
 * (subtype+rect) identical; document metadata identical; MediaBox, CropBox
 * and rotation untouched; ArtBox never changed; trim/bleed boxes equal the
 * plan (and an unplanned BleedBox keeps its exact rectangle); untouched
 * pages unchanged. Any unexpected difference fails closed.
 */
async function applyNormalization(pdfBytes, plan) {
  const checks = [];
  const fail = (id, detail) => {
    checks.push({ id, ok: false, detail });
    return { ok: false, outputBytes: null, checks, failure: id };
  };
  if (!plan || !Array.isArray(plan.changes) || plan.changes.length === 0) return fail('NO_PLAN', 'no plan to apply');

  let src;
  let beforeSnap;
  try {
    src = await PDFDocument.load(pdfBytes, { updateMetadata: false }); // NOT ignoreEncryption: encrypted input throws
    beforeSnap = snapshot(src);
  } catch (err) {
    return fail('LOAD_FAILED', err instanceof Error ? err.message : String(err));
  }
  if (src.isEncrypted) return fail('ENCRYPTED', 'encrypted PDF');
  if (isSigned(src)) return fail('SIGNED', 'digitally signed PDF');

  const pages = src.getPages();
  for (const change of plan.changes) {
    const page = pages[change.pageIndex];
    if (!page) return fail('PAGE_NOT_FOUND', `page ${change.pageIndex}`);
    const t = change.set.trimBox;
    page.setTrimBox(t.x, t.y, t.width, t.height);
    if (change.set.bleedBox) {
      const b = change.set.bleedBox;
      page.setBleedBox(b.x, b.y, b.width, b.height);
    }
  }

  let outputBytes;
  let after;
  try {
    outputBytes = await src.save();
    const reloaded = await PDFDocument.load(outputBytes, { updateMetadata: false });
    after = snapshot(reloaded);
  } catch (err) {
    return fail('SAVE_OR_RELOAD_FAILED', err instanceof Error ? err.message : String(err));
  }

  // --- verification on the saved output --------------------------------
  if (after.pageCount !== beforeSnap.pageCount) return fail('PAGE_COUNT_CHANGED', `${beforeSnap.pageCount} -> ${after.pageCount}`);
  checks.push({ id: 'PAGE_COUNT_UNCHANGED', ok: true });

  for (let i = 0; i < after.pages.length; i++) {
    const b = beforeSnap.pages[i];
    const a = after.pages[i];
    if (a.contents.length !== b.contents.length) return fail('CONTENT_STREAMS_CHANGED', `page ${i + 1}: stream count`);
    for (let k = 0; k < a.contents.length; k++) {
      if (!a.contents[k] || !b.contents[k] || !bytesEqual(a.contents[k], b.contents[k])) {
        return fail('CONTENT_STREAMS_CHANGED', `page ${i + 1}: stream ${k + 1}`);
      }
    }
    if (a.annots.length !== b.annots.length || a.annots.some((x, k) => x !== b.annots[k])) {
      return fail('ANNOTATIONS_CHANGED', `page ${i + 1}`);
    }
    if (!sameRect(a.media, b.media, 1e-6) || a.cropExplicit !== b.cropExplicit || !sameRect(a.crop, b.crop, 1e-6) || a.rotation !== b.rotation) {
      return fail('PAGE_GEOMETRY_CHANGED', `page ${i + 1}: media/crop/rotation`);
    }
  }
  checks.push({ id: 'CONTENT_STREAMS_BYTE_IDENTICAL', ok: true });
  checks.push({ id: 'ANNOTATIONS_UNCHANGED', ok: true });
  checks.push({ id: 'MEDIA_CROP_ROTATION_UNCHANGED', ok: true });

  if (JSON.stringify(after.meta) !== JSON.stringify(beforeSnap.meta)) return fail('METADATA_CHANGED', 'document info');
  checks.push({ id: 'METADATA_UNCHANGED', ok: true });

  // Fail closed on ANY box the plan did not ask to change: not just whether a
  // BleedBox/ArtBox exists, but its actual rectangle. (Exact comparison:
  // pdf-lib writes the numbers we gave it, so any difference is unexpected.)
  const EXACT = 1e-6;
  const sameOptionalBox = (explicitA, rectA, explicitB, rectB) =>
    explicitA === explicitB && (!explicitA || sameRect(rectA, rectB, EXACT));
  const planned = new Map(plan.changes.map((c) => [c.pageIndex, c]));
  for (let i = 0; i < after.pages.length; i++) {
    const a = after.pages[i];
    const b = beforeSnap.pages[i];
    const c = planned.get(i);
    // ArtBox is never part of any plan.
    if (!sameOptionalBox(a.artExplicit, a.art, b.artExplicit, b.art)) return fail('ART_BOX_CHANGED', `page ${i + 1}`);
    if (c) {
      if (!a.trimExplicit || !sameRect(a.trim, c.set.trimBox, EXACT)) return fail('TRIM_BOX_NOT_AS_PLANNED', `page ${i + 1}`);
      if (c.set.bleedBox) {
        if (!a.bleedExplicit || !sameRect(a.bleed, c.set.bleedBox, EXACT)) return fail('BLEED_BOX_NOT_AS_PLANNED', `page ${i + 1}`);
      } else if (!sameOptionalBox(a.bleedExplicit, a.bleed, b.bleedExplicit, b.bleed)) {
        return fail('BLEED_BOX_CHANGED', `page ${i + 1}`);
      }
    } else if (
      !sameOptionalBox(a.trimExplicit, a.trim, b.trimExplicit, b.trim) ||
      !sameOptionalBox(a.bleedExplicit, a.bleed, b.bleedExplicit, b.bleed)
    ) {
      return fail('UNPLANNED_BOX_CHANGE', `page ${i + 1}`);
    }
  }
  checks.push({ id: 'BLEED_ART_BOXES_UNCHANGED', ok: true });
  checks.push({ id: 'BOXES_MATCH_PLAN', ok: true });

  return { ok: true, outputBytes, checks, failure: null };
}

// ---------------------------------------------------------------------
// assess -> apply -> real preflight
// ---------------------------------------------------------------------

/**
 * The full, explicit-approval workflow: assess, apply the plan (if one
 * exists and passes the safety checks), then run the REAL preflight on the
 * output. `after` is the authoritative result; this function never decides
 * READY itself.
 *
 * @returns {Promise<{
 *   applied: boolean,
 *   assessment: object,
 *   outputBytes: Uint8Array,   // the new bytes when applied, otherwise the INPUT bytes
 *   safety: {ok: boolean, checks: object[], failure: string|null} | null,
 *   before: object|null,
 *   after: object|null,
 * }>}
 */
async function normalizePageGeometry(pdfBytes, opts = {}) {
  const { runPreflight } = require('./orchestrator');
  const assessment = await assessPageGeometry(pdfBytes, opts.userIntent);
  if (!assessment.plan) {
    return { applied: false, assessment, outputBytes: pdfBytes, safety: null, before: null, after: null };
  }
  const result = await applyNormalization(pdfBytes, assessment.plan);
  if (!result.ok) {
    return {
      applied: false,
      assessment,
      outputBytes: pdfBytes, // original preserved
      safety: { ok: false, checks: result.checks, failure: result.failure },
      before: null,
      after: null,
    };
  }
  const before = await runPreflight(pdfBytes, opts);
  const after = await runPreflight(result.outputBytes, opts);
  return {
    applied: true,
    assessment,
    outputBytes: result.outputBytes,
    safety: { ok: true, checks: result.checks, failure: null },
    before,
    after,
  };
}

module.exports = {
  assessPageGeometry,
  applyNormalization,
  normalizePageGeometry,
  CATEGORY,
  SIMILAR_TOLERANCE_PT,
};
