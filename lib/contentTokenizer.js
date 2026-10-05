/**
 * Minimal PDF content-stream tokenizer.
 *
 * Per Freya's hard requirement (2026-10-04): this must be PDF-aware, not a
 * regex find/replace on operator keywords. It does NOT need to understand
 * the whole PDF object model (no document structure, no indirect
 * references) -- only enough of the content-stream grammar to correctly
 * tell operands/operators apart and never mistake something INSIDE a
 * string, name, array, dict or comment for a real top-level operator.
 *
 * Every token carries its exact byte [start, end) range in the ORIGINAL
 * buffer, because the whole point (parse -> decide -> patch) is to never
 * rebuild the stream: only the byte ranges of specific recognized color
 * operators get replaced; everything else is copied through untouched.
 *
 * Token types produced:
 *   'number'   - a numeric operand (e.g. "0.8", "-3", "12")
 *   'name'     - a /Name token (value includes the leading slash, exactly
 *                as written -- #xx hex escapes are NOT decoded, since we
 *                only ever compare literal device-colorspace names like
 *                "/DeviceRGB" which never contain escapes in practice)
 *   'string'   - a (...) literal string, opaque (balanced parens, escapes
 *                honored only enough to find the matching close-paren)
 *   'hexstring'- a <...> hex string, opaque
 *   'array'    - a [...] array, opaque (balanced brackets)
 *   'dict'     - a <<...>> dict, opaque (balanced <</>> pairs; also covers
 *                BDC/DP property-list dicts)
 *   'inlineImage' - a full "BI ... ID <raw data> EI" block, opaque. The
 *                raw data between ID and EI is binary and must never be
 *                tokenized or searched for operator keywords.
 *   'operator' - a bareword keyword (e.g. "rg", "Tj", "q", "f*", "'")
 *   (whitespace and comments are consumed silently between tokens, not
 *   emitted as tokens -- they're never the start or end of a patch range)
 *
 * This is intentionally small: content streams are a much simpler grammar
 * than full PDF object syntax (no indirect refs, no streams-within-streams
 * other than inline images).
 */

'use strict';

const CC = {
  LParen: 0x28, RParen: 0x29, LAngle: 0x3c, RAngle: 0x3e,
  LBracket: 0x5b, RBracket: 0x5d, LBrace: 0x7b, RBrace: 0x7d,
  Slash: 0x2f, Percent: 0x25, Backslash: 0x5c,
};

function isWhitespace(c) {
  // PDF whitespace: NUL, TAB, LF, FF, CR, SPACE
  return c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
}

function isDelimiter(c) {
  return (
    c === CC.LParen || c === CC.RParen || c === CC.LAngle || c === CC.RAngle ||
    c === CC.LBracket || c === CC.RBracket || c === CC.LBrace || c === CC.RBrace ||
    c === CC.Slash || c === CC.Percent
  );
}

function isRegular(c) {
  return !isWhitespace(c) && !isDelimiter(c);
}

const NUMBER_RE = /^[+-]?(\d+\.\d*|\.\d+|\d+)$/;

/**
 * @param {Buffer|Uint8Array} buf
 * @returns {Array<{type:string, start:number, end:number, raw:string, value?:any}>}
 */
function tokenize(buf) {
  const tokens = [];
  const len = buf.length;
  let i = 0;

  function skipWhitespaceAndComments() {
    for (;;) {
      while (i < len && isWhitespace(buf[i])) i++;
      if (i < len && buf[i] === CC.Percent) {
        // Comment: % to end of line (not consuming the EOL itself matters
        // little since it's whitespace anyway).
        while (i < len && buf[i] !== 0x0a && buf[i] !== 0x0d) i++;
        continue;
      }
      break;
    }
  }

  function readBalanced(openByte, closeByte, type) {
    const start = i;
    let depth = 0;
    do {
      if (i >= len) throw new Error(`contentTokenizer: unterminated ${type} starting at byte ${start}`);
      const c = buf[i];
      if (c === CC.Backslash && type === 'string') {
        i += 2; // skip escaped char, never misread it as a delimiter
        continue;
      }
      if (c === openByte) depth++;
      else if (c === closeByte) depth--;
      i++;
    } while (depth > 0);
    return { type, start, end: i, raw: buf.toString('latin1', start, i) };
  }

  function readHexStringOrDict() {
    // '<<' starts a dict; a lone '<' starts a hex string. Both can nest
    // (dicts nest via further '<<'; a hex string never contains a raw
    // '<' or '>' except as its own terminator).
    if (buf[i + 1] === CC.LAngle) {
      const start = i;
      let depth = 0;
      do {
        if (i >= len) throw new Error(`contentTokenizer: unterminated dict starting at byte ${start}`);
        if (buf[i] === CC.LAngle && buf[i + 1] === CC.LAngle) { depth++; i += 2; continue; }
        if (buf[i] === CC.RAngle && buf[i + 1] === CC.RAngle) { depth--; i += 2; continue; }
        i++;
      } while (depth > 0);
      return { type: 'dict', start, end: i, raw: buf.toString('latin1', start, i) };
    }
    const start = i;
    i++; // skip '<'
    while (i < len && buf[i] !== CC.RAngle) i++;
    if (i >= len) throw new Error(`contentTokenizer: unterminated hex string starting at byte ${start}`);
    i++; // skip '>'
    return { type: 'hexstring', start, end: i, raw: buf.toString('latin1', start, i) };
  }

  function readRegularRun() {
    const start = i;
    while (i < len && isRegular(buf[i])) i++;
    const raw = buf.toString('latin1', start, i);
    return { start, end: i, raw };
  }

  function tryReadInlineImage(opRaw, opStart, opEnd) {
    if (opRaw !== 'ID') return null;
    // Raw binary data starts right after the single whitespace byte that
    // follows "ID" (per spec), and runs until a whitespace-delimited "EI".
    // We scan for "EI" preceded by whitespace and (heuristically) followed
    // by whitespace or end-of-stream -- the standard, pragmatic approach,
    // since inline image data is not otherwise self-delimiting.
    let dataStart = opEnd;
    if (dataStart < len && isWhitespace(buf[dataStart])) dataStart++;
    let j = dataStart;
    while (j < len - 1) {
      if (buf[j] === 0x45 /* E */ && buf[j + 1] === 0x49 /* I */) {
        const before = j === 0 ? 0x20 : buf[j - 1];
        const after = j + 2 >= len ? 0x20 : buf[j + 2];
        if (isWhitespace(before) && (j + 2 >= len || isWhitespace(after) || isDelimiter(after))) {
          return { dataStart, eiStart: j, eiEnd: j + 2 };
        }
      }
      j++;
    }
    throw new Error(`contentTokenizer: unterminated inline image (no EI found) starting near byte ${opStart}`);
  }

  while (true) {
    skipWhitespaceAndComments();
    if (i >= len) break;
    const c = buf[i];

    if (c === CC.LParen) {
      tokens.push(readBalanced(CC.LParen, CC.RParen, 'string'));
      continue;
    }
    if (c === CC.LBracket) {
      tokens.push(readBalanced(CC.LBracket, CC.RBracket, 'array'));
      continue;
    }
    if (c === CC.LAngle) {
      tokens.push(readHexStringOrDict());
      continue;
    }
    if (c === CC.Slash) {
      const start = i;
      i++; // skip '/'
      while (i < len && isRegular(buf[i])) i++;
      tokens.push({ type: 'name', start, end: i, raw: buf.toString('latin1', start, i), value: buf.toString('latin1', start, i) });
      continue;
    }
    if (c === CC.RParen || c === CC.RBracket || c === CC.RAngle || c === CC.RBrace || c === CC.LBrace) {
      // Stray/unexpected closing delimiter or brace outside any construct
      // we recognize -- shouldn't occur in well-formed content, but don't
      // hang: consume it as its own opaque 1-byte token rather than loop
      // forever or misclassify it.
      tokens.push({ type: 'punct', start: i, end: i + 1, raw: buf.toString('latin1', i, i + 1) });
      i++;
      continue;
    }

    // Regular-character run: either a number or an operator keyword.
    const { start, end, raw } = readRegularRun();
    if (NUMBER_RE.test(raw)) {
      tokens.push({ type: 'number', start, end, raw, value: parseFloat(raw) });
      continue;
    }
    tokens.push({ type: 'operator', start, end, raw });

    if (raw === 'BI') {
      // Inline image: keep consuming operator/name/number tokens (the
      // image dict entries between BI and ID use the same simple tokens)
      // until we hit "ID", then splice everything from BI's start through
      // EI's end into ONE opaque 'inlineImage' token, discarding the
      // intermediate tokens we just pushed (they're all inside the opaque
      // range now).
      const biStart = start;
      let idTok = null;
      for (;;) {
        skipWhitespaceAndComments();
        if (i >= len) throw new Error(`contentTokenizer: unterminated inline image (no ID found) starting at byte ${biStart}`);
        const cc = buf[i];
        if (cc === CC.Slash) { const s = i; i++; while (i < len && isRegular(buf[i])) i++; tokens.push({ type: 'name', start: s, end: i, raw: buf.toString('latin1', s, i), value: buf.toString('latin1', s, i) }); continue; }
        if (cc === CC.LBracket) { tokens.push(readBalanced(CC.LBracket, CC.RBracket, 'array')); continue; }
        if (cc === CC.LAngle) { tokens.push(readHexStringOrDict()); continue; }
        const run = readRegularRun();
        if (NUMBER_RE.test(run.raw)) { tokens.push({ type: 'number', ...run, value: parseFloat(run.raw) }); continue; }
        tokens.push({ type: 'operator', ...run });
        if (run.raw === 'ID') { idTok = run; break; }
      }
      const { eiEnd } = tryReadInlineImage('ID', biStart, idTok.end);
      i = eiEnd;
      // Collapse every token from biStart up to here into one opaque block.
      while (tokens.length && tokens[tokens.length - 1].start >= biStart) tokens.pop();
      tokens.push({ type: 'inlineImage', start: biStart, end: i, raw: buf.toString('latin1', biStart, i) });
    }
  }

  return tokens;
}

module.exports = { tokenize };
