/**
 * Content-stream color rewriter -- integration layer between
 * contentTokenizer.js and color.js, following the architecture Freya
 * specified and approved (2026-10-04):
 *
 *   content stream -> tokenizer -> operator records -> color-state
 *   tracker -> color.js -> patch list -> (original bytes + patches)
 *
 * The ORIGINAL stream bytes are NEVER rebuilt/reparsed/reserialized.
 * Every byte outside a patch range is copied through untouched. Each
 * patch replaces only the exact [start,end) byte range spanning one
 * color operator's operands + the operator keyword itself.
 *
 * SCOPE (Freya's tiered v1, approved 2026-10-04):
 *   Tier 1 (always supported):  g/G (DeviceGray), rg/RG (DeviceRGB),
 *                                k/K (DeviceCMYK)
 *   Tier 2 (needs cs/CS state):  cs/CS + sc/SC/scn/SCN, but ONLY when the
 *                                color space is a LITERAL device name --
 *                                /DeviceGray, /DeviceRGB, /DeviceCMYK.
 *                                A NAMED resource color space (e.g.
 *                                "/CS0 cs") cannot be resolved from the
 *                                content stream bytes alone (it requires
 *                                the page's Resources dictionary, which
 *                                this module deliberately does not read
 *                                -- out of scope for v1) and is therefore
 *                                treated as unsupported, not guessed.
 *   Tier 3 (never touched):     Separation, DeviceN, ICCBased, Pattern,
 *                                Indexed, Lab, CalRGB, CalGray, and any
 *                                named/indirect color space -- left
 *                                byte-for-byte untouched, reported as an
 *                                'unsupported_colorspace' diagnostic.
 *   Images (Do, inline BI..EI): entirely out of scope here -- a raster
 *                                image's own pixel data is a separate,
 *                                later task per Freya; this module does
 *                                not open or alter inlineImage tokens.
 *
 * Object-type context (text vs path, for color.js's policy layer) is
 * tracked locally via BT/ET nesting -- NOT reused from margin.js, which
 * works from pdfjs-dist's semantic operator list (no byte offsets) and
 * is a fundamentally different walk over the same content stream. Any
 * color-setting operator encountered while inside a BT...ET block is
 * classified 'text'; otherwise 'path'. (Images never reach color.js here
 * since image XObjects/inline images are out of scope.)
 *
 * NOTE on scope boundary: this module produces a patched content-stream
 * BUFFER plus a diagnostics list. It does NOT yet embed that buffer back
 * into a real PDF file (fixing /Length, re-encoding FlateDecode, etc.) --
 * that embedding step is separate follow-up work, not yet started.
 */

'use strict';

const { tokenize } = require('./contentTokenizer');
const { planColorConversion, planCmykConversion } = require('./color');

const DEVICE_SPACES = new Set(['/DeviceGray', '/DeviceRGB', '/DeviceCMYK']);
// Operand count a literal device color space takes with sc/SC/scn/SCN.
const DEVICE_SPACE_OPERAND_COUNT = { '/DeviceGray': 1, '/DeviceRGB': 3, '/DeviceCMYK': 4 };

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * @param {Buffer} buf  a page's (already-decoded) content-stream bytes --
 *   when a page's /Contents is an array of several content streams, this
 *   is ONE of those streams' own bytes, not the whole page.
 * @param {Object} opts
 * @param {string} [opts.paperType] passed through to color.js's policy functions
 * @param {{fillSpace:?string, strokeSpace:?string, stateStack:Array, inTextBlock:boolean}} [opts.initialState]
 *   Carries graphics/color state IN from a previous content stream on the
 *   same page (see pdfColorRewriter.js). Per the PDF spec (7.8.2), when
 *   /Contents is an array the division into separate stream objects has NO
 *   semantic meaning: operators never span a stream boundary, but q/Q
 *   nesting and the active cs/CS color space absolutely can (a `q` opened
 *   in stream N can be closed by `Q` in stream N+2; a `cs` set in stream N
 *   stays active in stream N+1 until changed or popped). Omitting this
 *   (the default -- fresh/empty state) is only correct for a single,
 *   complete, self-contained content stream.
 * @returns {{
 *   patchedBytes: Buffer,
 *   patches: Array<{start:number, end:number, before:string, after:string, objType:string, reason:string}>,
 *   diagnostics: Array<{type:string, start:number, end:number, detail:string}>,
 *   finalState: {fillSpace:?string, strokeSpace:?string, stateStack:Array, inTextBlock:boolean}
 * }}
 */
function rewriteContentStreamColors(buf, opts = {}) {
  const tokens = tokenize(buf);
  const patches = [];
  const diagnostics = [];

  // Color-space state machine -- deliberately separate from any CTM/clip
  // tracking (Freya: "color state — окремий state machine", "не
  // змішувати це з CTM"). Only q/Q affect it (graphics state save/restore);
  // cs/CS set it going forward until the next cs/CS or q/Q pop.
  const DEFAULT_STATE = { fillSpace: null, strokeSpace: null };
  const initial = opts.initialState || {};
  let state = initial.fillSpace !== undefined || initial.strokeSpace !== undefined
    ? { fillSpace: initial.fillSpace ?? null, strokeSpace: initial.strokeSpace ?? null }
    : { ...DEFAULT_STATE };
  const stateStack = Array.isArray(initial.stateStack) ? initial.stateStack.map((s) => ({ ...s })) : [];
  let inTextBlock = !!initial.inTextBlock;

  // Collect the N most recent numeric tokens immediately preceding index i
  // (the operator's own token index), requiring them to be contiguous
  // (no non-number token in between) -- operands always sit directly
  // before their operator with only whitespace/comments (already skipped
  // by the tokenizer) in between.
  function numericOperandsBefore(tokenIndex, count) {
    const out = [];
    let j = tokenIndex - 1;
    while (out.length < count && j >= 0 && tokens[j].type === 'number') {
      out.unshift(tokens[j]);
      j--;
    }
    if (out.length !== count) return null;
    return out;
  }

  function fmtNum(v) {
    // Keep output compact but exact enough; PDF numbers don't need fixed
    // precision. 6 decimal places is far more than printing needs and
    // avoids visible banding from rounding.
    const r = Math.round(v * 1e6) / 1e6;
    return String(r);
  }

  function applyPlan(objType, plan, operandTokens, opToken, newOperatorName) {
    if (plan.status === 'manual_review') {
      diagnostics.push({
        type: 'manual_review',
        start: operandTokens[0].start,
        end: opToken.end,
        detail: plan.reason,
      });
      return;
    }
    if (plan.status === 'safe' && !plan.forcedKOnly) {
      // Nothing to change -- the color already satisfies TAC (or no
      // paperType policy was requested at all).
      return;
    }
    // 'autofix', or 'safe' with forcedKOnly (K-only override IS a change
    // from whatever the source operator was, e.g. rg -> k).
    const newText = `${fmtNum(plan.c)} ${fmtNum(plan.m)} ${fmtNum(plan.y)} ${fmtNum(plan.k)} ${newOperatorName}`;
    patches.push({
      start: operandTokens[0].start,
      end: opToken.end,
      before: buf.toString('latin1', operandTokens[0].start, opToken.end),
      after: newText,
      objType,
      reason: plan.forcedKOnly ? 'forced K-only (neutral black text/path)' : plan.status,
    });
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'operator') continue;
    const objType = inTextBlock ? 'text' : 'path';

    switch (t.raw) {
      case 'q':
        stateStack.push(state);
        state = { ...state };
        continue;
      case 'Q':
        state = stateStack.pop() || { ...DEFAULT_STATE };
        continue;
      case 'BT':
        inTextBlock = true;
        continue;
      case 'ET':
        inTextBlock = false;
        continue;

      // --- Tier 1: self-contained device operators -------------------
      case 'g': case 'G': {
        const ops = numericOperandsBefore(i, 1);
        if (!ops) break;
        const gray = clamp01(ops[0].value);
        const plan = planColorConversion(objType, gray, gray, gray, opts);
        applyPlan(objType, plan, ops, t, t.raw === 'g' ? 'k' : 'K');
        continue;
      }
      case 'rg': case 'RG': {
        const ops = numericOperandsBefore(i, 3);
        if (!ops) break;
        const [r, gC, b] = ops.map((o) => clamp01(o.value));
        const plan = planColorConversion(objType, r, gC, b, opts);
        applyPlan(objType, plan, ops, t, t.raw === 'rg' ? 'k' : 'K');
        continue;
      }
      case 'k': case 'K': {
        const ops = numericOperandsBefore(i, 4);
        if (!ops) break;
        const [c, m, y, k] = ops.map((o) => clamp01(o.value));
        const plan = planCmykConversion(objType, c, m, y, k, opts);
        applyPlan(objType, plan, ops, t, t.raw); // same operator, values may change
        continue;
      }

      // --- Tier 2: generic operators, gated by cs/CS state ------------
      case 'cs': case 'CS': {
        const nameTok = i > 0 ? tokens[i - 1] : null;
        const spaceName = nameTok && nameTok.type === 'name' ? nameTok.value : null;
        if (t.raw === 'cs') state.fillSpace = spaceName;
        else state.strokeSpace = spaceName;
        if (!spaceName || !DEVICE_SPACES.has(spaceName)) {
          diagnostics.push({
            type: 'unsupported_colorspace',
            start: nameTok ? nameTok.start : t.start,
            end: t.end,
            detail: `${t.raw} ${spaceName || '(unknown)'} — not a literal device color space (resource-indirected or Separation/DeviceN/ICCBased/Pattern/Indexed/Lab/Cal*); left untouched.`,
          });
        }
        continue;
      }
      case 'sc': case 'SC': case 'scn': case 'SCN': {
        const isStroke = t.raw === 'SC' || t.raw === 'SCN';
        const space = isStroke ? state.strokeSpace : state.fillSpace;
        if (!space || !DEVICE_SPACES.has(space)) {
          // Already reported as unsupported at the cs/CS that set this
          // space (or no cs/CS was ever seen -- the content stream's
          // default color space, also out of scope for v1). Don't
          // double-report per sc/scn call; just skip.
          continue;
        }
        // scn/SCN with a trailing name operand (pattern) is Tier 3 even
        // under a literal device space header, per Freya: operand count
        // is decided by the color space, and a pattern name here means
        // this isn't really a plain device color after all.
        if (i > 0 && tokens[i - 1].type === 'name') {
          diagnostics.push({
            type: 'unsupported_colorspace',
            start: tokens[i - 1].start,
            end: t.end,
            detail: `${t.raw} with a pattern name operand under ${space} — not a plain device color; left untouched.`,
          });
          continue;
        }
        const count = DEVICE_SPACE_OPERAND_COUNT[space];
        const ops = numericOperandsBefore(i, count);
        if (!ops) break;
        if (space === '/DeviceGray') {
          const gray = clamp01(ops[0].value);
          const plan = planColorConversion(objType, gray, gray, gray, opts);
          applyPlan(objType, plan, ops, t, isStroke ? 'K' : 'k');
        } else if (space === '/DeviceRGB') {
          const [r, gC, b] = ops.map((o) => clamp01(o.value));
          const plan = planColorConversion(objType, r, gC, b, opts);
          applyPlan(objType, plan, ops, t, isStroke ? 'K' : 'k');
        } else {
          const [c, m, y, k] = ops.map((o) => clamp01(o.value));
          const plan = planCmykConversion(objType, c, m, y, k, opts);
          applyPlan(objType, plan, ops, t, isStroke ? 'K' : 'k');
        }
        continue;
      }
      default:
        continue;
    }
  }

  // Apply patches to a fresh copy of the buffer, in one pass, left to
  // right -- patches never overlap (each spans exactly one operator's
  // own operands+keyword) so simple sequential splicing is safe.
  patches.sort((a, b) => a.start - b.start);
  const pieces = [];
  let cursor = 0;
  for (const p of patches) {
    pieces.push(buf.subarray(cursor, p.start));
    pieces.push(Buffer.from(p.after, 'latin1'));
    cursor = p.end;
  }
  pieces.push(buf.subarray(cursor));
  const patchedBytes = Buffer.concat(pieces);

  const finalState = {
    fillSpace: state.fillSpace,
    strokeSpace: state.strokeSpace,
    stateStack: stateStack.map((s) => ({ ...s })),
    inTextBlock,
  };

  return { patchedBytes, patches, diagnostics, finalState };
}

module.exports = { rewriteContentStreamColors, DEVICE_SPACES };
