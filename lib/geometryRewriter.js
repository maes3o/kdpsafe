'use strict';

/**
 * Content-stream geometry rewriter -- CHECKPOINT 4 (2026-10-05), the
 * Phase-1 (margin/LEM) analogue of lib/colorRewriter.js's byte-patch
 * architecture (tokenize -> locate -> patch exact byte range -> splice),
 * reused for the SAME reason: never rebuild/reparse the stream, never
 * touch a byte outside the one operator being changed.
 *
 * SCOPE, DELIBERATELY NARROW (v1, matching lib/autofix.js's own
 * shift-never-scale promise and this project's "never guess" rule):
 *
 *   Supports EXACTLY ONE case: a simple axis-aligned rectangle drawn via
 *   a single `re` (rectangle) construction operator, painted (not just
 *   clipped) directly, under an IDENTITY CTM (no `q`+`cm` transform
 *   currently in effect at that point in the stream). This is, not by
 *   coincidence, the exact shape every one of this repo's own path-object
 *   test fixtures already uses (test/make-safezone-fixtures.js's
 *   `rectOps()`).
 *
 *   Explicitly NOT supported (left byte-for-byte untouched, reported as
 *   'not_found' rather than guessed at): curves (c/v/y), multi-segment
 *   paths, text (Tj/TJ/'/"), images (Do/inline BI..EI), Form XObjects, and
 *   any `re` under a non-identity CTM (rotated/scaled/translated via
 *   `cm`) -- a correct fix for those would need to either transform the
 *   shift back into that local coordinate space or rewrite the `cm`
 *   itself, neither of which is implemented here. A future checkpoint can
 *   extend this; this one does not silently approximate it.
 *
 *   If more than one `re` candidate in the same content stream matches
 *   the target geometry within tolerance, this module refuses to pick one
 *   ('ambiguous') rather than guessing which occurrence corresponds to the
 *   object lib/margin.js's pdfjs-dist-based detector found -- the two
 *   pipelines (this byte tokenizer vs. pdfjs's semantic operator list)
 *   have no shared indexing to disambiguate by position alone.
 */

const { tokenize } = require('./contentTokenizer');
const { matMul } = require('./margin');

const IDENTITY = [1, 0, 0, 1, 0, 0];
const CTM_EPSILON = 1e-6;

// Operators that actually paint the current path (as opposed to merely
// defining it or using it as a clip). `n` (no-op, "end path without
// painting") is deliberately excluded -- a `re ... W n` sequence defines a
// CLIP rectangle only, never something lib/margin.js's analyzePageObjects()
// would report as a visible object, so it must never be mistaken for a
// paint-eligible candidate here.
const PAINT_OPS = new Set(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*']);
const CLIP_MARK_OPS = new Set(['W', 'W*']);

function isIdentity(m) {
  return (
    Math.abs(m[0] - 1) < CTM_EPSILON &&
    Math.abs(m[1]) < CTM_EPSILON &&
    Math.abs(m[2]) < CTM_EPSILON &&
    Math.abs(m[3] - 1) < CTM_EPSILON &&
    Math.abs(m[4]) < CTM_EPSILON &&
    Math.abs(m[5]) < CTM_EPSILON
  );
}

function numericOperandsBefore(tokens, tokenIndex, count) {
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
  const r = Math.round(v * 1e6) / 1e6;
  return String(r);
}

/**
 * Finds every `re` operator in `buf` that is (a) under an identity CTM,
 * (b) painted (not clip-only), and (c) whose rectangle matches
 * `targetRawBBoxPt` within `epsilon` points. Does NOT patch anything --
 * pure search, so callers can detect 'ambiguous' before any byte is
 * touched.
 */
function findMatchingRectCandidates(buf, targetRawBBoxPt, epsilon) {
  const tokens = tokenize(buf);
  const candidates = [];

  let ctm = IDENTITY;
  const stack = [];
  let pendingRect = null; // { ops, opToken, ctmAtRe }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'operator') continue;

    switch (t.raw) {
      case 'q':
        stack.push(ctm);
        continue;
      case 'Q':
        ctm = stack.pop() || IDENTITY;
        pendingRect = null; // a path never spans a q/Q boundary in valid content
        continue;
      case 'cm': {
        const ops = numericOperandsBefore(tokens, i, 6);
        if (ops) ctm = matMul(ctm, ops.map((o) => o.value));
        continue;
      }
      case 're': {
        const ops = numericOperandsBefore(tokens, i, 4);
        if (!ops) {
          pendingRect = null;
          continue;
        }
        pendingRect = { ops, opToken: t, ctmAtRe: ctm };
        continue;
      }
      case 'm':
      case 'l':
      case 'c':
      case 'v':
      case 'y':
      case 'h':
        // Any other path-construction operator means this is NOT a
        // simple single-`re` path -- abandon the pending candidate rather
        // than risk treating a multi-segment path as a plain rectangle.
        pendingRect = null;
        continue;
      case 'W':
      case 'W*':
        // Clip marker -- does not disqualify a following paint op, but a
        // pending rect followed by ONLY `n` (no paint op) must not be
        // treated as a candidate; handled by falling through to default
        // below (W/W* themselves don't end the path).
        continue;
      case 'n':
        // Path ends without painting -- clip-only (or a no-op path).
        // Never a paint-eligible candidate.
        pendingRect = null;
        continue;
      default:
        if (pendingRect && PAINT_OPS.has(t.raw)) {
          const { ops, opToken, ctmAtRe } = pendingRect;
          if (isIdentity(ctmAtRe)) {
            const x = ops[0].value;
            const y = ops[1].value;
            const w = ops[2].value;
            const h = ops[3].value;
            const rectBBox = { minX: x, minY: y, maxX: x + w, maxY: y + h };
            const matches =
              Math.abs(rectBBox.minX - targetRawBBoxPt.minX) <= epsilon &&
              Math.abs(rectBBox.minY - targetRawBBoxPt.minY) <= epsilon &&
              Math.abs(rectBBox.maxX - targetRawBBoxPt.maxX) <= epsilon &&
              Math.abs(rectBBox.maxY - targetRawBBoxPt.maxY) <= epsilon;
            if (matches) {
              candidates.push({ xToken: ops[0], yToken: ops[1], x, y, w, h });
            }
          }
        }
        pendingRect = null;
        continue;
    }
  }

  return candidates;
}

/**
 * Shifts exactly one `re`-drawn, identity-CTM, painted rectangle whose raw
 * geometry matches `targetRawBBoxPt` by (dx, dy) -- a pure translation,
 * width/height unchanged, mirroring lib/autofix.js's planAutofix()'s own
 * "shift, never scale" rule.
 *
 * @returns {{status: 'applied'|'not_found'|'ambiguous', patchedBytes?: Buffer, patch?: object}}
 */
function shiftRectInContentStream(buf, { targetRawBBoxPt, dx, dy, epsilon = 0.51 }) {
  const candidates = findMatchingRectCandidates(buf, targetRawBBoxPt, epsilon);

  if (candidates.length === 0) return { status: 'not_found' };
  if (candidates.length > 1) return { status: 'ambiguous' };

  const { xToken, yToken, x, y } = candidates[0];
  const newX = x + dx;
  const newY = y + dy;

  // Patch x and y independently (they are two separate number tokens,
  // not necessarily adjacent in a way that makes a single combined patch
  // simpler) -- apply right-to-left so earlier byte offsets stay valid.
  const pieces = [];
  let cursor = 0;
  const patchesSorted = [
    { start: xToken.start, end: xToken.end, after: fmtNum(newX) },
    { start: yToken.start, end: yToken.end, after: fmtNum(newY) },
  ].sort((a, b) => a.start - b.start);

  for (const p of patchesSorted) {
    pieces.push(buf.subarray(cursor, p.start));
    pieces.push(Buffer.from(p.after, 'latin1'));
    cursor = p.end;
  }
  pieces.push(buf.subarray(cursor));
  const patchedBytes = Buffer.concat(pieces);

  return {
    status: 'applied',
    patchedBytes,
    patch: { before: { x, y }, after: { x: newX, y: newY }, dx, dy },
  };
}

module.exports = { shiftRectInContentStream, findMatchingRectCandidates };
