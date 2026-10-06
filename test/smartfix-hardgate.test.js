'use strict';

const assert = require('node:assert/strict');
const { checkHardGate } = require('../lib/smartfix/hardGate');
const { planRepair } = require('../lib/smartfix/smartFixEngine');
const fx = require('./make-smartfix-fixtures');

async function main() {
  // 1) Encrypted PDF -> blocked, DO_NOT_TOUCH, and planRepair() must never
  //    even attempt geometry analysis (zero plans, not "plans full of
  //    MANUAL_REVIEW").
  const encryptedBytes = await fx.buildEncryptedPdf();
  const encryptedGate = await checkHardGate(encryptedBytes);
  assert.equal(encryptedGate.blocked, true, 'encrypted PDF must block the hard gate');
  assert.ok(encryptedGate.reasons.includes('ENCRYPTED'), 'reason must name ENCRYPTED');

  const encryptedPlan = await planRepair(encryptedBytes, fx.TARGET_6X9_NO_BLEED);
  assert.equal(encryptedPlan.documentStatus, 'DO_NOT_TOUCH');
  assert.equal(encryptedPlan.plans.length, 0, 'no per-page plans must be generated for a DO_NOT_TOUCH document');
  console.log('OK: encrypted PDF -> DO_NOT_TOUCH, zero plans generated.');

  // 2) Signed PDF (/Sig field WITH a real /V) -> blocked.
  const signedBytes = await fx.buildSignedPdf();
  const signedGate = await checkHardGate(signedBytes);
  assert.equal(signedGate.blocked, true, 'a real digital signature must block the hard gate');
  assert.ok(signedGate.reasons.includes('DIGITALLY_SIGNED'));

  const signedPlan = await planRepair(signedBytes, fx.TARGET_6X9_NO_BLEED);
  assert.equal(signedPlan.documentStatus, 'DO_NOT_TOUCH');
  assert.equal(signedPlan.plans.length, 0);
  console.log('OK: digitally-signed PDF -> DO_NOT_TOUCH, zero plans generated.');

  // 3) An UNSIGNED /Sig placeholder field (no /V yet) must NOT block —
  //    nothing has been signed yet, so there is nothing a byte change
  //    could invalidate.
  const placeholderBytes = await fx.buildUnsignedPlaceholderFieldPdf();
  const placeholderGate = await checkHardGate(placeholderBytes);
  assert.equal(placeholderGate.blocked, false, 'an unsigned Sig placeholder field must not block the gate');
  console.log('OK: unsigned /Sig placeholder field does not block the hard gate.');

  // 4) A perfectly ordinary PDF must not block.
  const plainBytes = await fx.buildExactSizeNoBoxes();
  const plainGate = await checkHardGate(plainBytes);
  assert.equal(plainGate.blocked, false);
  assert.deepEqual(plainGate.reasons, []);
  console.log('OK: ordinary PDF passes the hard gate with zero reasons.');

  console.log('\nAll Smart Fix hard-gate tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
