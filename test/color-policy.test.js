'use strict';

const assert = require('node:assert/strict');
const { planColorConversion } = require('../lib/color');

// --- 1) Pure/near-pure black TEXT, any paper type -> forced to true
//    K-only (bypassing the generic rich-black GCR formula -- standard
//    prepress practice: body text must never be rich black, since
//    multi-plate misregistration on tiny strokes shows as color
//    fringing). Always 'safe', never needs TAC reduction. ---
for (const paperType of ['cream', 'white', 'standardColor', 'premiumColor']) {
  const r = planColorConversion('text', 0, 0, 0, { paperType });
  assert.equal(r.status, 'safe', `black text on ${paperType} should always be safe`);
  assert.equal(r.forcedKOnly, true, 'black text must be flagged as forced K-only');
  assert.equal(r.c, 0, 'forced K-only text must have c=0');
  assert.equal(r.m, 0, 'forced K-only text must have m=0');
  assert.equal(r.y, 0, 'forced K-only text must have y=0');
  assert.equal(r.k, 1, 'forced K-only text must have k=1 (K100)');
}

// --- 1b) The same override applies to a near-black (not just exactly
//    0,0,0) text color, within tolerance. ---
{
  const r = planColorConversion('text', 0.01, 0.012, 0.008, { paperType: 'cream' });
  assert.equal(r.forcedKOnly, true, 'near-black text should still get the K-only override');
}

// --- 1c) Per Freya's refinement (2026-10-04): the override extends to
//    PATH too (same misregistration risk on thin vector strokes), but
//    NEVER to IMAGE -- a photo's near-black pixels must go through
//    ordinary color-managed conversion, not a pixel-level K-only snap. ---
{
  const path = planColorConversion('path', 0, 0, 0, { paperType: 'premiumColor' });
  assert.equal(path.forcedKOnly, true, 'pure black PATH should also get the K-only override');

  const image = planColorConversion('image', 0, 0, 0, { paperType: 'premiumColor' });
  assert.notEqual(image.forcedKOnly, true, 'image must NEVER get the K-only override, even for pure black');
  assert.ok(image.c > 0, 'pure black as an IMAGE pixel should still produce rich black (c>0) via the normal GCR formula');
}

// --- 1d) Freya's worked RGB-0..255 test table (converted to 0..1),
//    checked directly against isNeutralBlack's threshold/tolerance logic
//    via planColorConversion('path', ...): dark+neutral forces K-only;
//    dark+chromatic does not; "not dark enough" does not either. ---
{
  const asForced = (r255, g255, b255) =>
    planColorConversion('path', r255 / 255, g255 / 255, b255 / 255, { paperType: 'premiumColor' }).forcedKOnly === true;

  assert.equal(asForced(0, 0, 0), true, 'RGB 0/0/0 -> forced K-only');
  assert.equal(asForced(1, 1, 1), true, 'RGB 1/1/1 -> forced K-only');
  assert.equal(asForced(5, 5, 5), true, 'RGB 5/5/5 -> forced K-only');
  assert.equal(asForced(0, 3, 5), false, 'RGB 0/3/5 (dark but chromatic) -> must NOT be forced');
  assert.equal(asForced(5, 0, 0), false, 'RGB 5/0/0 (dark but chromatic) -> must NOT be forced');
  assert.equal(asForced(20, 20, 20), false, 'RGB 20/20/20 (not dark enough) -> normal conversion');
  console.log('Freya test table: all cases match expected forced/not-forced classification.');
}

// --- 2) Colored (non-neutral) text that WOULD need TAC reduction ->
//    manual_review, color must NOT be silently changed (reason cites the
//    numbers). A saturated dark mix that is clearly NOT neutral black. ---
{
  const r = planColorConversion('text', 0.05, 0.3, 0.05, { paperType: 'cream' });
  assert.equal(r.status, 'manual_review', 'colored text exceeding TAC must go to manual review');
  assert.match(r.reason, /Текстовий об'єкт перевищує TAC/);
  console.log('Colored text over TAC ->', r.status, '-', r.reason);
}

// --- 3) Same source color, but as a PATH (vector fill) -> autofix allowed,
//    CMY reduced, K left untouched. ---
{
  const r = planColorConversion('path', 0.05, 0.05, 0.05, { paperType: 'cream' });
  assert.equal(r.status, 'autofix', 'path exceeding TAC should autofix');
  assert.ok(r.tacPercent <= 240.01, 'autofixed path must respect the limit');
  console.log('Same color as path ->', r.status, `tac=${r.tacPercent.toFixed(1)}%`);
}

// --- 4) Same source color, as an IMAGE -> also autofix allowed. ---
{
  const r = planColorConversion('image', 0.05, 0.05, 0.05, { paperType: 'cream' });
  assert.equal(r.status, 'autofix', 'image exceeding TAC should autofix');
  assert.ok(r.tacPercent <= 240.01, 'autofixed image must respect the limit');
}

// --- 5) A light color, well under any limit, for any type -> safe,
//    untouched (raw === returned). ---
for (const objType of ['text', 'path', 'image']) {
  const r = planColorConversion(objType, 0.9, 0.85, 0.8, { paperType: 'cream' });
  assert.equal(r.status, 'safe', `${objType}: light color should be safe`);
}

// --- 6) No paperType given at all -> always 'safe' (no TAC policy
//    requested), regardless of type. ---
{
  const r = planColorConversion('path', 0, 0, 0); // pure black, no paperType
  assert.equal(r.status, 'safe');
}

// --- 7) Unknown paperType still throws, same as rgbToCmyk. ---
{
  assert.throws(() => planColorConversion('path', 0, 0, 0, { paperType: 'glossy' }), /unknown paperType/);
}

console.log('\nAll color-policy.test.js tests passed.');
