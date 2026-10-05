'use strict';

const assert = require('node:assert/strict');
const { rgbToCmyk, TAC_LIMIT_PERCENT } = require('../lib/color');

function approxEqual(actual, expected, tolerance, msg) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${msg}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

// --- Pure white -> no ink at all ---
{
  const r = rgbToCmyk(1, 1, 1);
  approxEqual(r.c, 0, 1e-6, 'white c');
  approxEqual(r.m, 0, 1e-6, 'white m');
  approxEqual(r.y, 0, 1e-6, 'white y');
  approxEqual(r.k, 0, 1e-6, 'white k');
}

// --- Pure black -> with gcrAmount=0.8, k = 0.8, remaining c/m/y pick up the rest ---
{
  const r = rgbToCmyk(0, 0, 0, { gcrAmount: 0.8 });
  approxEqual(r.k, 0.8, 1e-6, 'black k at gcrAmount 0.8');
  // c0=m0=y0=1, kFull=1, k=0.8 -> c=(1-0.8)/(1-0.8)=1
  approxEqual(r.c, 1, 1e-6, 'black c');
  approxEqual(r.m, 1, 1e-6, 'black m');
  approxEqual(r.y, 1, 1e-6, 'black y');
  // Total ink with no TAC limit applied: 1+1+1+0.8 = 380% (this is exactly
  // why a TAC clamp matters for near-black mixes).
  approxEqual((r.c + r.m + r.y + r.k) * 100, 380, 0.01, 'black raw TAC before clamping');
}

// --- Full GCR (gcrAmount=1) on pure black -> pure K, zero C/M/Y ---
{
  const r = rgbToCmyk(0, 0, 0, { gcrAmount: 1 });
  approxEqual(r.k, 1, 1e-6, 'full GCR black k');
  approxEqual(r.c, 0, 1e-6, 'full GCR black c');
  approxEqual(r.m, 0, 1e-6, 'full GCR black m');
  approxEqual(r.y, 0, 1e-6, 'full GCR black y');
}

// --- No GCR (gcrAmount=0) -> naive inversion, k=0 ---
{
  const r = rgbToCmyk(0.2, 0.4, 0.6, { gcrAmount: 0 });
  approxEqual(r.k, 0, 1e-6, 'gcrAmount 0 -> k is 0');
  approxEqual(r.c, 0.8, 1e-6, 'gcrAmount 0 -> naive c');
  approxEqual(r.m, 0.6, 1e-6, 'gcrAmount 0 -> naive m');
  approxEqual(r.y, 0.4, 1e-6, 'gcrAmount 0 -> naive y');
}

// --- TAC clamping, per paper type, on a near-black mix that exceeds every limit ---
for (const [paperType, limit] of Object.entries(TAC_LIMIT_PERCENT)) {
  const r = rgbToCmyk(0.05, 0.05, 0.05, { paperType });
  assert.ok(r.clamped, `${paperType}: near-black mix should trigger clamping`);
  assert.ok(r.tacPercent <= limit + 0.01, `${paperType}: clamped TAC (${r.tacPercent}) must not exceed the ${limit}% limit`);
  console.log(`${paperType} (limit ${limit}%): c=${r.c.toFixed(3)} m=${r.m.toFixed(3)} y=${r.y.toFixed(3)} k=${r.k.toFixed(3)} tac=${r.tacPercent.toFixed(1)}%`);
}

// --- Cream's limit (240) is the strictest -> for the SAME input color, cream
// must end up with LESS total ink than premiumColor (300) ---
{
  const cream = rgbToCmyk(0.05, 0.05, 0.05, { paperType: 'cream' });
  const premium = rgbToCmyk(0.05, 0.05, 0.05, { paperType: 'premiumColor' });
  assert.ok(cream.tacPercent < premium.tacPercent, 'cream should end up with strictly less total ink than premiumColor for the same source color');
  // K is untouched by clamping in both cases (same gcrAmount, same input).
  approxEqual(cream.k, premium.k, 1e-6, 'K should be identical across paper types (only C/M/Y are scaled)');
}

// --- A light, low-ink color should NOT be clamped on any paper type ---
for (const paperType of Object.keys(TAC_LIMIT_PERCENT)) {
  const r = rgbToCmyk(0.9, 0.85, 0.8, { paperType });
  assert.equal(r.clamped, false, `${paperType}: a light color should never need clamping`);
}

// --- Invalid inputs ---
{
  assert.throws(() => rgbToCmyk(1.5, 0, 0), /must be a number in \[0,1\]/);
  assert.throws(() => rgbToCmyk(0, 0, 0, { paperType: 'glossy' }), /Unknown paperType|unknown paperType/);
}

console.log('\nAll color.test.js tests passed.');
