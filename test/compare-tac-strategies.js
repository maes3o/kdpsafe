'use strict';

/**
 * Comparison harness for 3 candidate TAC-reduction strategies, per Freya's
 * advice (2026-10-04): don't commit to a single formula on theory alone —
 * build a small test set of real-ish CMYK cases and see where each
 * strategy actually damages color, before writing the production algorithm.
 *
 * Strategies compared:
 *   A. CMY-only   — current color.js behavior. K is never touched; C/M/Y
 *                   scaled down proportionally to hit the limit. Fails
 *                   (falls back to zeroing C/M/Y) only if K alone already
 *                   exceeds the limit.
 *   B. Proportional — naive: scale ALL FOUR channels (including K) down by
 *                   the same factor to hit the limit.
 *   C. CMY-first, K-fallback — Freya's recommended direction (baseline
 *                   numeric version, no object-type/neutrality awareness
 *                   yet): try CMY-only first; only if C/M/Y alone can't
 *                   reach the limit (i.e. K itself already exceeds it),
 *                   reduce K down to the limit and zero C/M/Y.
 *
 * This file does NOT touch lib/color.js — it's a throwaway comparison
 * report, not production code. Nothing here is wired into the app yet.
 */

function tac(c, m, y, k) {
  return (c + m + y + k) * 100;
}

function strategyCmyOnly(c, m, y, k, limit) {
  const t = tac(c, m, y, k);
  if (t <= limit) return { c, m, y, k, tac: t, clamped: false, kReduced: false };
  const kPercent = k * 100;
  const target = limit - kPercent;
  const cmySum = c + m + y;
  if (target <= 0 || cmySum <= 0) {
    return { c: 0, m: 0, y: 0, k, tac: kPercent, clamped: true, kReduced: false, note: 'K alone >= limit; CMY zeroed, K left as-is (exceeds limit!)' };
  }
  const scale = target / (cmySum * 100);
  const c2 = c * scale, m2 = m * scale, y2 = y * scale;
  return { c: c2, m: m2, y: y2, k, tac: tac(c2, m2, y2, k), clamped: true, kReduced: false };
}

function strategyProportional(c, m, y, k, limit) {
  const t = tac(c, m, y, k);
  if (t <= limit) return { c, m, y, k, tac: t, clamped: false, kReduced: false };
  const scale = limit / t;
  const c2 = c * scale, m2 = m * scale, y2 = y * scale, k2 = k * scale;
  return { c: c2, m: m2, y: y2, k: k2, tac: tac(c2, m2, y2, k2), clamped: true, kReduced: true };
}

function strategyCmyFirstKFallback(c, m, y, k, limit) {
  const t = tac(c, m, y, k);
  if (t <= limit) return { c, m, y, k, tac: t, clamped: false, kReduced: false };
  const kPercent = k * 100;
  const target = limit - kPercent;
  const cmySum = c + m + y;
  if (target >= 0 && cmySum > 0) {
    // CMY alone can reach the limit -- K untouched.
    const scale = target / (cmySum * 100);
    const c2 = c * scale, m2 = m * scale, y2 = y * scale;
    return { c: c2, m: m2, y: y2, k, tac: tac(c2, m2, y2, k), clamped: true, kReduced: false };
  }
  // CMY alone is NOT enough (K itself already exceeds, or there's no CMY to
  // reduce) -- zero CMY and bring K itself down to the limit.
  const newK = Math.min(k, limit / 100);
  return { c: 0, m: 0, y: 0, k: newK, tac: newK * 100, clamped: true, kReduced: true };
}

// Euclidean distance in channel-percent space -- a crude proxy for
// "how much did we visually disturb this color" (not a real deltaE,
// just enough to compare strategies against each other consistently).
function channelDelta(orig, result) {
  const dc = (result.c - orig.c) * 100;
  const dm = (result.m - orig.m) * 100;
  const dy = (result.y - orig.y) * 100;
  const dk = (result.k - orig.k) * 100;
  return Math.sqrt(dc * dc + dm * dm + dy * dy + dk * dk);
}

// --- 20 test cases -------------------------------------------------------
// c/m/y/k in 0..1. `limit` is the paper's TAC limit being tested against.
// `kind` records what KIND of object this ink mix represents, per Freya's
// point that text/vector/image/background should eventually get different
// treatment -- not used by the strategies yet, just recorded for the report.
const cases = [
  { name: 'Near-black neutral (standardColor)', kind: 'vector', c: 0.80, m: 0.70, y: 0.60, k: 0.80, limit: 270 },
  { name: 'Full solid black (standardColor)', kind: 'vector', c: 1.00, m: 1.00, y: 1.00, k: 1.00, limit: 270 },
  { name: 'K-only text, under limit (control)', kind: 'text', c: 0, m: 0, y: 0, k: 1.00, limit: 270 },
  { name: 'Rich black bg at cream limit (borderline)', kind: 'background', c: 0.60, m: 0.40, y: 0.40, k: 1.00, limit: 240 },
  { name: 'Saturated orange, under limit (control)', kind: 'vector', c: 0.10, m: 0.70, y: 0.90, k: 0, limit: 270 },
  { name: 'Dark saturated blue (cream)', kind: 'image', c: 0.90, m: 0.85, y: 0.10, k: 0.70, limit: 240 },
  { name: 'Skin-tone-ish, under limit (control)', kind: 'image', c: 0.20, m: 0.40, y: 0.45, k: 0.05, limit: 270 },
  { name: 'Heavy C/M overprint (standardColor)', kind: 'vector', c: 1.00, m: 1.00, y: 0.00, k: 0.20, limit: 270 },
  { name: 'Mid neutral gray, under limit (control)', kind: 'vector', c: 0.50, m: 0.40, y: 0.40, k: 0.30, limit: 270 },
  { name: 'Near-black warm (standardColor)', kind: 'image', c: 0.70, m: 0.75, y: 0.80, k: 0.75, limit: 270 },
  { name: 'Dark green exactly at limit', kind: 'vector', c: 0.90, m: 0.30, y: 0.90, k: 0.60, limit: 270 },
  { name: 'Shadow detail photo (premiumColor)', kind: 'image', c: 0.85, m: 0.80, y: 0.75, k: 0.90, limit: 300 },
  { name: 'Large solid K area, no CMY (control)', kind: 'background', c: 0, m: 0, y: 0, k: 0.95, limit: 270 },
  { name: 'Small K text w/ slight tint (control)', kind: 'text', c: 0.05, m: 0.05, y: 0.05, k: 1.00, limit: 270 },
  { name: 'Deep purple over cream limit', kind: 'vector', c: 0.95, m: 0.90, y: 0.20, k: 0.50, limit: 240 },
  { name: 'Rich black, standard print mix', kind: 'background', c: 0.75, m: 0.68, y: 0.67, k: 0.90, limit: 270 },
  { name: 'Bright saturated yellow (control)', kind: 'vector', c: 0.05, m: 0.05, y: 0.95, k: 0, limit: 270 },
  { name: 'Near-black cool (premiumColor)', kind: 'image', c: 0.85, m: 0.80, y: 0.75, k: 0.85, limit: 300 },
  { name: 'Full CMY, zero K (no K to fall back on)', kind: 'vector', c: 1.00, m: 1.00, y: 1.00, k: 0, limit: 270 },
  { name: 'K nearly maxed, small CMY (control)', kind: 'text', c: 0.15, m: 0.10, y: 0.10, k: 0.98, limit: 270 },
];

function fmt(v) {
  return (v * 100).toFixed(1).padStart(5);
}

console.log('='.repeat(110));
console.log('TAC STRATEGY COMPARISON — A: CMY-only | B: Proportional (incl. K) | C: CMY-first, K-fallback');
console.log('='.repeat(110));

const rows = [];

for (const tc of cases) {
  const orig = { c: tc.c, m: tc.m, y: tc.y, k: tc.k };
  const origTac = tac(tc.c, tc.m, tc.y, tc.k);
  const a = strategyCmyOnly(tc.c, tc.m, tc.y, tc.k, tc.limit);
  const b = strategyProportional(tc.c, tc.m, tc.y, tc.k, tc.limit);
  const c = strategyCmyFirstKFallback(tc.c, tc.m, tc.y, tc.k, tc.limit);

  console.log(`\n[${tc.kind}] ${tc.name}`);
  console.log(`  original: C${fmt(tc.c)} M${fmt(tc.m)} Y${fmt(tc.y)} K${fmt(tc.k)}  TAC=${origTac.toFixed(1)}%  limit=${tc.limit}%`);
  if (origTac <= tc.limit) {
    console.log('  -- under limit, no reduction needed (control case) --');
    rows.push({ ...tc, origTac, needsReduction: false });
    continue;
  }
  const da = channelDelta(orig, a);
  const db = channelDelta(orig, b);
  const dc = channelDelta(orig, c);
  console.log(`  A CMY-only:     C${fmt(a.c)} M${fmt(a.m)} Y${fmt(a.y)} K${fmt(a.k)}  TAC=${a.tac.toFixed(1)}%  Δ=${da.toFixed(1)}${a.note ? '  !! ' + a.note : ''}`);
  console.log(`  B Proportional: C${fmt(b.c)} M${fmt(b.m)} Y${fmt(b.y)} K${fmt(b.k)}  TAC=${b.tac.toFixed(1)}%  Δ=${db.toFixed(1)}`);
  console.log(`  C CMY-first+Kfb:C${fmt(c.c)} M${fmt(c.m)} Y${fmt(c.y)} K${fmt(c.k)}  TAC=${c.tac.toFixed(1)}%  Δ=${dc.toFixed(1)}${c.kReduced ? '  (K was reduced)' : ''}`);

  rows.push({
    ...tc, origTac, needsReduction: true,
    deltaA: da, deltaB: db, deltaC: dc,
    kTouchedA: false, kTouchedB: true, kTouchedC: c.kReduced,
  });
}

console.log('\n' + '='.repeat(110));
console.log('SUMMARY (only cases that needed reduction)');
console.log('='.repeat(110));
console.log('name'.padEnd(42), 'kind'.padEnd(12), 'ΔA(CMY-only)'.padEnd(14), 'ΔB(propor.)'.padEnd(14), 'ΔC(K-fallback)'.padEnd(16), 'K touched?');
for (const r of rows.filter((r) => r.needsReduction)) {
  console.log(
    r.name.slice(0, 40).padEnd(42),
    r.kind.padEnd(12),
    r.deltaA.toFixed(1).padEnd(14),
    r.deltaB.toFixed(1).padEnd(14),
    r.deltaC.toFixed(1).padEnd(16),
    `A:no B:yes C:${r.kTouchedC ? 'yes' : 'no'}`
  );
}

const needing = rows.filter((r) => r.needsReduction);
const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
console.log('\nAverage Δ across all cases needing reduction:');
console.log(`  A CMY-only:      ${avg(needing.map((r) => r.deltaA)).toFixed(2)}`);
console.log(`  B Proportional:  ${avg(needing.map((r) => r.deltaB)).toFixed(2)}`);
console.log(`  C CMY-first+Kfb: ${avg(needing.map((r) => r.deltaC)).toFixed(2)}`);

const cTouchedK = needing.filter((r) => r.kTouchedC).length;
console.log(`\nStrategy C touched K in ${cTouchedK}/${needing.length} reduced cases (only when K alone >= limit).`);
console.log(`Strategy A left K untouched in ALL cases, but in cases where K alone >= limit, A leaves the object OVER the TAC limit (see "!!" notes above) -- a real correctness gap in the current color.js.`);

console.log('\nDone. This is a comparison report only -- lib/color.js has not been changed.');
