/**
 * RGB -> CMYK conversion for print, with partial GCR (Gray Component
 * Replacement) and a per-paper-type Total Area Coverage (TAC) limit.
 *
 * Reviewed with Gemini and Freya (2026-10-04):
 *   - Naive inversion (c=1-r, m=1-g, y=1-b, k=0) is rejected — it ignores
 *     ink absorption and TAC, producing muddy colors and, worse, physical
 *     show-through/cockling on absorbent paper.
 *   - Full ICC/CMM color management is rejected as too heavy for a
 *     client-side WASM tool.
 *   - Compromise: partial GCR (GCR_AMOUNT < 1, so rich color saturation
 *     isn't lost the way full GCR loses it) + a hard TAC ceiling.
 *
 * GCR_AMOUNT=0.8 and the TAC limits below are **KDPSafe's own working
 * values**, not a published KDP specification — KDP does not publish a
 * CMYK TAC table. They match the paperType enum already defined in
 * spine.js and are treated as a working hypothesis pending real
 * production/print characterization:
 *   cream          240% (absorbent, uncoated — highest show-through risk)
 *   white          270% (uncoated, holds slightly more ink than cream)
 *   standardColor  270% (same base stock as white, per spine.js's shared bulk factor)
 *   premiumColor   300% (coated/denser stock, holds the most ink)
 *
 * When the raw partial-GCR result exceeds a paper's TAC limit, only the
 * C/M/Y channels are scaled down to meet it — K (black) is left untouched.
 * This is a real property of the algorithm, not a "cascade" or "fallback"
 * system: verified (2026-10-04, 20-case comparison + Freya's confirmation)
 * that for every possible input under these specific limits (minimum 240%),
 * K alone (max 100%) can mathematically never exceed the limit, so a
 * K-reduction branch would be dead code here and was deliberately not
 * added. If the TAC limits are ever lowered below 100% this invariant
 * would need re-checking — not expected for KDP-style print specs.
 */

'use strict';

const GCR_AMOUNT = 0.8;

// KDPSafe's own working TAC limits (see file header) — not an official
// KDP specification.
const TAC_LIMIT_PERCENT = Object.freeze({
  cream: 240,
  white: 270,
  standardColor: 270,
  premiumColor: 300,
});

/**
 * @param {number} r 0..1
 * @param {number} g 0..1
 * @param {number} b 0..1
 * @param {Object} [opts]
 * @param {number} [opts.gcrAmount] 0 (no GCR, same as naive-but-with-K-from-min) .. 1 (full GCR)
 * @param {string} [opts.paperType] one of TAC_LIMIT_PERCENT's keys; omit to skip the TAC clamp
 * @returns {{c:number,m:number,y:number,k:number, tacPercent:number, clamped:boolean}}
 */
// Shared by rgbToCmyk (after GCR) and processCmyk (direct CMYK input) --
// Freya's point (2026-10-04, color-rewriter review): a PDF that already
// states DeviceCMYK via k/K must never be round-tripped through RGB to
// reach this reducer (CMYK -> RGB -> CMYK loses information for no
// reason). This function is the one TAC-reduction implementation both
// entry points share -- scale C/M/Y down (K untouched) so the total lands
// on the limit; see the file header for why a K-reduction branch is
// deliberately absent given our current >=240% limits.
function reduceCmyToLimit(c, m, y, k, limit) {
  let tacPercent = (c + m + y + k) * 100;
  let clamped = false;
  if (tacPercent > limit) {
    const cmySum = c + m + y;
    const kPercent = k * 100;
    const targetCmyPercent = limit - kPercent;
    if (cmySum > 0 && targetCmyPercent > 0) {
      const scale = targetCmyPercent / (cmySum * 100);
      c *= scale;
      m *= scale;
      y *= scale;
    } else if (targetCmyPercent <= 0) {
      // K alone already exceeds the limit (only possible with an
      // aggressive gcrAmount/limit combination) — zero out C/M/Y.
      c = m = y = 0;
    }
    tacPercent = (c + m + y + k) * 100;
    clamped = true;
  }
  return { c, m, y, k, tacPercent, clamped };
}

function checkPaperType(paperType, callerName) {
  if (!paperType) return undefined;
  const limit = TAC_LIMIT_PERCENT[paperType];
  if (limit === undefined) {
    throw new Error(`${callerName}: unknown paperType "${paperType}". Expected one of: ${Object.keys(TAC_LIMIT_PERCENT).join(', ')}`);
  }
  return limit;
}

function rgbToCmyk(r, g, b, opts = {}) {
  const gcrAmount = opts.gcrAmount ?? GCR_AMOUNT;
  for (const [name, v] of [['r', r], ['g', g], ['b', b]]) {
    if (typeof v !== 'number' || v < 0 || v > 1 || Number.isNaN(v)) {
      throw new Error(`rgbToCmyk: ${name} must be a number in [0,1], got ${v}`);
    }
  }

  const c0 = 1 - r;
  const m0 = 1 - g;
  const y0 = 1 - b;
  const kFull = Math.min(c0, m0, y0);
  const k = gcrAmount * kFull;

  let c, m, y;
  if (k >= 1) {
    c = m = y = 0;
  } else {
    c = (c0 - k) / (1 - k);
    m = (m0 - k) / (1 - k);
    y = (y0 - k) / (1 - k);
  }
  // Numerical safety: clamp to [0,1] (floating point can push these
  // a hair outside the range at k -> 1 or k -> 0).
  c = Math.min(1, Math.max(0, c));
  m = Math.min(1, Math.max(0, m));
  y = Math.min(1, Math.max(0, y));

  const limit = checkPaperType(opts.paperType, 'rgbToCmyk');
  if (limit === undefined) {
    return { c, m, y, k, tacPercent: (c + m + y + k) * 100, clamped: false };
  }
  return reduceCmyToLimit(c, m, y, k, limit);
}

/**
 * Direct CMYK -> TAC-checked-CMYK, for PDF content that already states
 * DeviceCMYK (k/K operator) -- no RGB round-trip, no GCR formula (the
 * color is already separated; GCR is only a concern when WE derive CMYK
 * from RGB ourselves). Freya, 2026-10-04: "не треба робити CMYK -> RGB ->
 * CMYK, бо це абсолютно непотрібна втрата інформації."
 *
 * @param {number} c 0..1
 * @param {number} m 0..1
 * @param {number} y 0..1
 * @param {number} k 0..1
 * @param {Object} [opts]
 * @param {string} [opts.paperType] one of TAC_LIMIT_PERCENT's keys; omit to skip the TAC check
 * @returns {{c:number,m:number,y:number,k:number,tacPercent:number,clamped:boolean}}
 */
function processCmyk(c, m, y, k, opts = {}) {
  for (const [name, v] of [['c', c], ['m', m], ['y', y], ['k', k]]) {
    if (typeof v !== 'number' || v < 0 || v > 1 || Number.isNaN(v)) {
      throw new Error(`processCmyk: ${name} must be a number in [0,1], got ${v}`);
    }
  }
  const limit = checkPaperType(opts.paperType, 'processCmyk');
  if (limit === undefined) {
    return { c, m, y, k, tacPercent: (c + m + y + k) * 100, clamped: false };
  }
  return reduceCmyToLimit(c, m, y, k, limit);
}

// Standard prepress practice, independent of Gemini/Freya's TAC review:
// black TEXT (and, per Freya's refinement, near-neutral-black PATH fills)
// should be K-ONLY (K100, no C/M/Y), never "rich black" (CMY+K). Rich
// black is fine for large solid areas, but on small text strokes,
// multi-plate misregistration on press makes rich black show as visible
// color fringing/blur around letterforms. The generic partial-GCR formula
// does NOT produce K-only for neutral black (gcrAmount=0.8 -> pure black
// becomes C100 M100 Y100 K80, TAC 380% -- confirmed by color.test.js's own
// "black raw TAC before clamping" case) so this needs a deliberate
// override, found while testing planColorConversion against the "K-only
// text never needs reduction" invariant: that invariant is only true if
// text is actually forced to K-only first.
//
// Freya's refinement (2026-10-04): a flat "r,g,b <= threshold" test would
// also catch a very dark but intentionally CHROMATIC color (e.g. a dark
// blue RGB(0,3,5) or dark magenta RGB(5,0,5)) and wrongly force it to
// K-only, destroying the author's actual color choice. So:
//   - EXACT black (r=g=b=0) is unconditionally K-only.
//   - Near-black is K-only only if it's both dark (max channel small) AND
//     NEUTRAL (channels close to each other, i.e. low saturation) --
//     max-min small. A dark but clearly chromatic near-black is left
//     alone and goes through normal conversion.
// Thresholds are in 0..1 (8/255 and 3/255 respectively, chosen to match
// Freya's worked RGB-0..255 examples: 0/0/0 and 1..5/1..5/1..5 forced,
// 0/3/5 and 5/0/0 NOT forced, 10/10/10+ treated as normal conversion).
const NEUTRAL_BLACK_MAX = 8 / 255;
const NEUTRAL_BLACK_TOLERANCE = 3 / 255;
function isNeutralBlack(r, g, b) {
  const max = Math.max(r, g, b);
  if (max === 0) return true; // exact black -- unconditional
  const min = Math.min(r, g, b);
  return max <= NEUTRAL_BLACK_MAX && (max - min) <= NEUTRAL_BLACK_TOLERANCE;
}

// Per Freya: this override applies to TEXT and PATH (both are vector-ish,
// author-controlled strokes/fills where rich black on a thin shape risks
// the same misregistration fringing as thin text). It must NOT apply to
// IMAGE -- a photo can have countless legitimate near-black pixels, and
// forcing each one to K-only pixel-by-pixel would visibly shift shadow
// detail. Images go through ordinary color-managed conversion + TAC only.
const K_ONLY_OVERRIDE_TYPES = new Set(['text', 'path']);

/**
 * Object-specific color safety policy — Freya's point (2026-10-04): TAC
 * correctness (is tacPercent <= limit?) doesn't need to know what kind of
 * object a color belongs to, but whether it's SAFE to auto-correct that
 * color does. This is deliberately a thin policy layer on top of
 * rgbToCmyk, not part of the TAC math itself, and deliberately does NOT
 * try to distinguish rich-black/background/photographic-image (scope
 * creep per Freya) — just the three types margin.js already produces:
 *
 *   text  — if the raw conversion needs ANY TAC reduction, that means
 *           this is colored text with CMY in the mix (pure/near-pure
 *           K-only text can never exceed a >=240% limit, proven
 *           2026-10-04). Changing a color actually used in body text is
 *           a visible, author-intent change, so it's never auto-fixed —
 *           same philosophy as margin/autofix.js treating all text
 *           violations as manual_review.
 *   path  — near-neutral-black fills/strokes are forced K-only (same
 *           misregistration risk as text, per Freya); otherwise CMY-only
 *           TAC reduction is allowed.
 *   image — CMY-only reduction is allowed; NO pixel-level K-only
 *           override (a photo can have countless legitimate near-black
 *           pixels — forcing them to K-only would visibly shift shadow
 *           detail). Perceptual (Lab/deltaE) validation is a possible
 *           future refinement, not needed now.
 *
 * @param {string} objType 'text' | 'path' | 'image'
 * @param {number} r 0..1
 * @param {number} g 0..1
 * @param {number} b 0..1
 * @param {Object} [opts] same as rgbToCmyk's opts; opts.paperType is
 *   required to get anything other than 'safe' back.
 * @returns {{status: 'safe'|'autofix'|'manual_review', reason?: string,
 *   c:number, m:number, y:number, k:number, tacPercent:number}}
 */
function planColorConversion(objType, r, g, b, opts = {}) {
  // Validate paperType up front, even on the K-only override's early-return
  // path below -- an unknown paperType should always fail loudly, the same
  // way rgbToCmyk's own check does, regardless of which branch would
  // otherwise have skipped needing the limit value.
  if (opts.paperType && TAC_LIMIT_PERCENT[opts.paperType] === undefined) {
    throw new Error(`planColorConversion: unknown paperType "${opts.paperType}". Expected one of: ${Object.keys(TAC_LIMIT_PERCENT).join(', ')}`);
  }

  // Black/near-neutral-black text and path fills bypass the generic GCR
  // formula entirely -- forced to true K-only (see isNeutralBlack's and
  // K_ONLY_OVERRIDE_TYPES's comments above; image is deliberately
  // excluded). This can never need TAC reduction (K<=100% < any of our
  // >=240% limits), and is never "clamped" -- it's the correct target
  // value, not a correction. Overprint is a separate PDF attribute this
  // module doesn't touch at all -- per Freya, forcing K100 color must
  // never imply forcing overprint too; whatever the source object's
  // overprint setting was stays untouched, elsewhere in the pipeline.
  if (K_ONLY_OVERRIDE_TYPES.has(objType) && isNeutralBlack(r, g, b)) {
    return { status: 'safe', c: 0, m: 0, y: 0, k: 1, tacPercent: 100, clamped: false, forcedKOnly: true };
  }

  // Raw conversion with no paperType -> no TAC clamp applied, so
  // raw.tacPercent is the UNCLAMPED total ink, exactly what we need to
  // decide whether any reduction would be needed at all.
  const raw = rgbToCmyk(r, g, b, { gcrAmount: opts.gcrAmount });

  if (!opts.paperType) {
    return { status: 'safe', ...raw };
  }

  const limit = TAC_LIMIT_PERCENT[opts.paperType];
  if (limit === undefined) {
    throw new Error(`planColorConversion: unknown paperType "${opts.paperType}". Expected one of: ${Object.keys(TAC_LIMIT_PERCENT).join(', ')}`);
  }

  if (raw.tacPercent <= limit) {
    return { status: 'safe', ...raw };
  }

  if (objType === 'text') {
    return {
      status: 'manual_review',
      reason: `Текстовий об'єкт перевищує TAC-ліміт (${raw.tacPercent.toFixed(1)}% > ${limit}%) — автоматична зміна кольору тексту заборонена, потрібне ручне рішення.`,
      ...raw,
    };
  }

  // path / image: CMY-only reduction is allowed — recompute WITH the
  // paperType so rgbToCmyk actually applies the clamp.
  const fixed = rgbToCmyk(r, g, b, opts);
  return { status: 'autofix', ...fixed };
}

/**
 * Same policy shape as planColorConversion, for content that already
 * states DeviceCMYK directly (a PDF's k/K operator) — see processCmyk's
 * doc comment for why this never routes through RGB.
 *
 * Deliberately does NOT apply the black-only-text/path override:
 * isNeutralBlack's override exists to correct an ARTIFACT of our own
 * RGB->CMYK GCR formula (which turns RGB black into rich black unless
 * overridden). A PDF that already states CMYK explicitly via k/K was
 * authored that way on purpose — e.g. an intentional rich-black k/K text
 * color is the author's own choice, not something KDPSafe introduced, so
 * forcing it to K-only here would be unrequested meddling beyond TAC
 * safety. TAC policy (never auto-fix text, CMY-only autofix for
 * path/image) still applies exactly as in planColorConversion.
 *
 * @param {string} objType 'text' | 'path' | 'image'
 * @param {number} c 0..1
 * @param {number} m 0..1
 * @param {number} y 0..1
 * @param {number} k 0..1
 * @param {Object} [opts]
 * @param {string} [opts.paperType] one of TAC_LIMIT_PERCENT's keys
 * @returns {{status: 'safe'|'autofix'|'manual_review', reason?: string,
 *   c:number, m:number, y:number, k:number, tacPercent:number}}
 */
function planCmykConversion(objType, c, m, y, k, opts = {}) {
  const raw = processCmyk(c, m, y, k, {}); // no paperType -> raw.tacPercent is unclamped

  if (!opts.paperType) {
    return { status: 'safe', ...raw };
  }

  const limit = checkPaperType(opts.paperType, 'planCmykConversion');

  if (raw.tacPercent <= limit) {
    return { status: 'safe', ...raw };
  }

  if (objType === 'text') {
    return {
      status: 'manual_review',
      reason: `Текстовий об'єкт перевищує TAC-ліміт (${raw.tacPercent.toFixed(1)}% > ${limit}%) — автоматична зміна кольору тексту заборонена, потрібне ручне рішення.`,
      ...raw,
    };
  }

  const fixed = processCmyk(c, m, y, k, opts);
  return { status: 'autofix', ...fixed };
}

module.exports = {
  rgbToCmyk,
  processCmyk,
  planColorConversion,
  planCmykConversion,
  isNeutralBlack,
  GCR_AMOUNT,
  TAC_LIMIT_PERCENT,
};
