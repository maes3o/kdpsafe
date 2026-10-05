'use strict';

const assert = require('node:assert/strict');
const { rewriteContentStreamColors } = require('../lib/colorRewriter');

function run(src, opts) {
  return rewriteContentStreamColors(Buffer.from(src), opts);
}

// --- 1) Pure black RGB fill on a path -> forced K-only override fires
//    regardless of paperType (prepress correctness, not paper-dependent),
//    patched rg -> k. ---
{
  const { patchedBytes, patches } = run('q 0 0 0 rg 10 10 100 100 re f Q');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].after, '0 0 0 1 k');
  assert.equal(patchedBytes.toString(), 'q 0 0 0 1 k 10 10 100 100 re f Q');
}

// --- 2) Mid-gray RGB, well under any TAC limit -> 'safe', untouched
//    byte-for-byte. ---
{
  const src = 'q 0.5 0.5 0.5 rg 10 10 100 100 re f Q';
  const { patchedBytes, patches, diagnostics } = run(src, { paperType: 'white' });
  assert.equal(patches.length, 0);
  assert.equal(diagnostics.length, 0);
  assert.equal(patchedBytes.toString(), src);
}

// --- 3) Saturated color exceeding TAC, as a PATH fill -> autofix patch,
//    rg -> k, CMY reduced to hit the cream limit (240%), K untouched. ---
{
  const src = 'q 0.05 0.3 0.05 rg 10 10 100 100 re f Q';
  const { patches, diagnostics } = run(src, { paperType: 'cream' });
  assert.equal(diagnostics.length, 0);
  assert.equal(patches.length, 1);
  assert.match(patches[0].after, /^[\d.]+ [\d.]+ [\d.]+ [\d.]+ k$/);
  const [c, m, y, k] = patches[0].after.split(' ').map(Number);
  assert.ok(Math.abs((c + m + y + k) * 100 - 240) < 0.01, 'patched color should sit exactly on the 240% TAC limit');
  assert.ok(Math.abs(k - 0.56) < 0.001, 'K must be untouched by the CMY-only reduction');
  console.log('Path over TAC, patched to:', patches[0].after);
}

// --- 4) THE SAME color, but inside BT...ET (text) -> manual_review
//    diagnostic, NO patch -- text color is never silently changed. ---
{
  const src = 'BT /F1 12 Tf 0.05 0.3 0.05 rg (hello) Tj ET';
  const { patches, diagnostics } = run(src, { paperType: 'cream' });
  assert.equal(patches.length, 0, 'text color exceeding TAC must never be auto-patched');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].type, 'manual_review');
  assert.match(diagnostics[0].detail, /TAC/);
}

// --- 5) k/K already DeviceCMYK, exceeding TAC as a path -> autofix via
//    processCmyk (no RGB round-trip), same operator kept (k, not rg/g). ---
{
  const src = 'q 0.9 0.85 0.1 0.7 k 10 10 100 100 re f Q'; // raw TAC 255%
  const { patches } = run(src, { paperType: 'cream' }); // limit 240
  assert.equal(patches.length, 1);
  const [c, m, y, k] = patches[0].after.split(' ').map(Number);
  assert.ok(Math.abs(k - 0.7) < 0.001, 'K from an explicit k operator must stay exactly as authored');
  assert.ok(Math.abs((c + m + y + k) * 100 - 240) < 0.01);
  assert.ok(patches[0].after.endsWith(' k'), 'operator must remain k (not switched to rg/g)');
}

// --- 6) cs/CS with a LITERAL device name, then scn with the matching
//    operand count -> treated exactly like rg/g/k. ---
{
  const src = 'q /DeviceRGB cs 0.05 0.3 0.05 scn 10 10 100 100 re f Q';
  const { patches, diagnostics } = run(src, { paperType: 'cream' });
  assert.equal(diagnostics.length, 0);
  assert.equal(patches.length, 1);
  assert.ok(patches[0].after.endsWith(' k'));
}

// --- 7) cs with a NAMED RESOURCE color space (e.g. "/CS0") -- cannot be
//    resolved from content-stream bytes alone -> unsupported_colorspace
//    diagnostic at the cs, and the later scn is silently skipped (not
//    double-reported), with NO patch produced at all. ---
{
  const src = 'q /CS0 cs 0.1 0.2 0.3 scn 10 10 100 100 re f Q';
  const { patches, diagnostics } = run(src, { paperType: 'cream' });
  assert.equal(patches.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].type, 'unsupported_colorspace');
  assert.match(diagnostics[0].detail, /CS0/);
}

// --- 8) A literal but non-device space name (e.g. /Separation used
//    directly, however unusual) is ALSO unsupported -- only the three
//    literal device names are ever treated as supported. ---
{
  const src = 'q /Separation cs 1 scn 10 10 100 100 re f Q';
  const { patches, diagnostics } = run(src, { paperType: 'cream' });
  assert.equal(patches.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].type, 'unsupported_colorspace');
}

// --- 9) scn with a trailing pattern NAME operand, even under a literal
//    device cs header -- Tier 3, never touched. ---
{
  const src = 'q /DeviceRGB cs /P1 scn 10 10 100 100 re f Q';
  const { patches, diagnostics } = run(src, { paperType: 'cream' });
  assert.equal(patches.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].detail, /pattern name operand/);
}

// --- 10) Nested q/Q correctly save/restore color-space state (separate
//    from CTM): cs set inside q...Q must not leak out after Q. ---
{
  const src = 'q /DeviceCMYK cs Q 0.1 0.2 0.3 scn 10 10 100 100 re f';
  const { patches, diagnostics } = run(src, { paperType: 'cream' });
  // After Q, fillSpace reverts to null (no cs ever set at the outer
  // level) -- the scn call has no known space and must be silently
  // skipped (no color space was ever reported unsupported either, since
  // no cs/CS token exists at all outside the popped q/Q).
  assert.equal(patches.length, 0);
  assert.equal(diagnostics.length, 0);
}

// --- 11) Byte-for-byte guarantee: everything outside a patch range is
//    copied through identically, including comments and odd spacing. ---
{
  const src = 'q  0  0  0  rg   % black fill\n10 10 100 100 re f\nQ';
  const { patchedBytes } = run(Buffer.from(src).toString(), {});
  // The comment and the "10 10 100 100 re f" region must survive
  // byte-for-byte; only the "0  0  0  rg" region (now including the
  // forced K-only override) differs.
  assert.ok(patchedBytes.toString().includes('% black fill\n10 10 100 100 re f\nQ'));
}

console.log('All colorRewriter.test.js tests passed.');
