'use strict';

const assert = require('node:assert/strict');
const { tokenize } = require('../lib/contentTokenizer');

function types(tokens) {
  return tokens.map((t) => t.type);
}
function ops(tokens) {
  return tokens.filter((t) => t.type === 'operator').map((t) => t.raw);
}

// --- 1) Basic numbers + operator. ---
{
  const toks = tokenize(Buffer.from('1 0 0 rg'));
  assert.deepEqual(toks.map((t) => t.raw), ['1', '0', '0', 'rg']);
  assert.deepEqual(types(toks), ['number', 'number', 'number', 'operator']);
}

// --- 2) Freya's #1 hard requirement: "rg" INSIDE a string must NOT be
//    read as an operator. ---
{
  const toks = tokenize(Buffer.from('(this has rg inside it) Tj'));
  assert.deepEqual(types(toks), ['string', 'operator']);
  assert.equal(toks[0].raw, '(this has rg inside it)');
  assert.equal(toks[1].raw, 'Tj');
}

// --- 2b) "rg" inside a COMMENT must also not be read as an operator
//    (and the comment itself produces no token at all). ---
{
  const toks = tokenize(Buffer.from('% a comment mentioning rg and k\n0 0 0 k'));
  assert.deepEqual(ops(toks), ['k']);
  assert.deepEqual(toks.map((t) => t.raw), ['0', '0', '0', 'k']);
}

// --- 2c) "rg" inside a NAME (/rgSomething) must not be read as a bare
//    operator either -- it's part of the name token. ---
{
  const toks = tokenize(Buffer.from('/rgSomething cs'));
  assert.equal(toks[0].type, 'name');
  assert.equal(toks[0].value, '/rgSomething');
  assert.equal(toks[1].raw, 'cs');
}

// --- 3) Escaped parens inside a string don't terminate it early. ---
{
  const toks = tokenize(Buffer.from('(a \\) b) Tj'));
  assert.equal(toks[0].type, 'string');
  assert.equal(toks[0].raw, '(a \\) b)');
}

// --- 4) Nested arrays are captured as one opaque token. ---
{
  const toks = tokenize(Buffer.from('[1 2 [3 4] 5] TJ'));
  assert.equal(toks[0].type, 'array');
  assert.equal(toks[0].raw, '[1 2 [3 4] 5]');
  assert.equal(toks[1].raw, 'TJ');
}

// --- 5) Hex string vs dict disambiguation. ---
{
  const toks = tokenize(Buffer.from('<48656C6C6F> Tj'));
  assert.equal(toks[0].type, 'hexstring');
  assert.equal(toks[0].raw, '<48656C6C6F>');
}
{
  const toks = tokenize(Buffer.from('<< /Tag /P >> BDC'));
  assert.equal(toks[0].type, 'dict');
  assert.equal(toks[0].raw, '<< /Tag /P >>');
  assert.equal(toks[1].raw, 'BDC');
}

// --- 6) Nested q/Q and cs/scn sequence, exact byte ranges recoverable. ---
{
  const src = 'q\n  0.1 0.2 0.3 rg\n  q\n    0 0 0 1 k\n  Q\nQ';
  const buf = Buffer.from(src);
  const toks = tokenize(buf);
  assert.deepEqual(ops(toks), ['q', 'rg', 'q', 'k', 'Q', 'Q']);
  // Spot-check byte-exact round trip for one operator's operand+op range.
  const rgIdx = toks.findIndex((t) => t.raw === 'rg');
  const numStart = toks[rgIdx - 3].start;
  const opEnd = toks[rgIdx].end;
  assert.equal(buf.toString('latin1', numStart, opEnd), '0.1 0.2 0.3 rg');
}

// --- 7) Inline image: BI ... ID <raw binary, possibly containing bytes
//    that LOOK like "rg" or parens> ... EI collapses to ONE opaque token,
//    and nothing inside it is misread as an operator/string/etc. ---
{
  // Deliberately stuff the "binary" payload with a paren and the text
  // "rg" to prove it's never tokenized as a string or an operator.
  const payloadBytes = Buffer.from('\x01\x02(rg)\xff\x00EI_LOOKALIKE_BUT_NOT_REAL');
  const src = Buffer.concat([
    Buffer.from('BI /W 2 /H 2 /BPC 8 /CS /G ID '),
    payloadBytes,
    Buffer.from(' EI\nQ'),
  ]);
  const toks = tokenize(src);
  assert.equal(toks[0].type, 'inlineImage');
  assert.ok(toks[0].raw.startsWith('BI '));
  assert.ok(toks[0].raw.endsWith('EI'));
  assert.equal(toks[1].raw, 'Q');
  // The lookalike "EI" inside the payload must NOT have ended the image
  // early -- confirm by checking the full captured range includes the
  // later, real "EI" and the payload bytes in between verbatim.
  assert.ok(toks[0].raw.includes('EI_LOOKALIKE_BUT_NOT_REAL'));
}

// --- 8) Byte offsets are exact and allow lossless reconstruction: joining
//    [start,end) ranges of ALL tokens plus the gaps between them must
//    reproduce the original buffer exactly (this is the property the
//    patch-based rewriter depends on). ---
{
  const src = Buffer.from('q 1 0 0 1 100 200 cm 0.5 0.5 0.5 rg\n(hi) Tj\nQ % trailing comment');
  const toks = tokenize(src);
  // Reconstruct by copying original bytes for every byte position --
  // this just confirms no token overlaps/gaps corrupt offsets, i.e. every
  // token.raw matches src.toString at [start,end).
  for (const t of toks) {
    assert.equal(src.toString('latin1', t.start, t.end), t.raw, `token ${JSON.stringify(t.raw)} offsets mismatch`);
  }
  // And tokens must be in non-decreasing, non-overlapping order.
  for (let k = 1; k < toks.length; k++) {
    assert.ok(toks[k].start >= toks[k - 1].end, `token ${k} overlaps previous token`);
  }
}

console.log('All contentTokenizer.test.js tests passed.');
