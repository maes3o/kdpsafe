'use strict';

/**
 * Smart Fix Phase 1 — mandatory hard gate.
 *
 * Per smart-fix-engine-research.md §8: encryption and digital signatures
 * are a flat, non-strategy-dependent rule. Checked FIRST, before any other
 * Smart Fix module (geometry detection included) ever reads this document.
 * When this gate blocks, nothing downstream runs — not "runs and gets
 * downgraded to MANUAL_REVIEW", but never invoked at all. DO_NOT_TOUCH is
 * the one level with no "maybe" in it.
 *
 * Read-only: this module never writes a byte. It only decides whether the
 * rest of Smart Fix is allowed to even look further at page geometry.
 */

const { PDFDocument, PDFName } = require('pdf-lib');

/**
 * @param {Uint8Array} pdfBytes
 * @returns {Promise<{ blocked: boolean, reasons: string[] }>}
 */
async function checkHardGate(pdfBytes) {
  let doc;
  try {
    // ignoreEncryption:true lets pdf-lib OPEN an encrypted file for
    // read-only inspection (the same pattern already used by
    // orchestrator.js/pdfAutofixWriter.js) — this does NOT mean the
    // document is safe to modify; doc.isEncrypted below is what actually
    // decides that.
    doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  } catch (err) {
    // Fails safe: a document this engine cannot even parse must never be
    // silently treated as "no problems detected". Any downstream caller
    // sees this exactly like a DO_NOT_TOUCH block.
    return { blocked: true, reasons: [`DOCUMENT_UNREADABLE: ${err.message}`] };
  }

  const reasons = [];

  if (doc.isEncrypted) {
    reasons.push('ENCRYPTED');
  }

  if (hasSignatureField(doc)) {
    reasons.push('DIGITALLY_SIGNED');
  }

  return { blocked: reasons.length > 0, reasons };
}

/**
 * Detects a /Sig AcroForm field carrying a real signature value (/V
 * present and non-null). An UNSIGNED signature placeholder field (FT=Sig,
 * no /V yet) is not itself a reason to refuse — nothing has been signed
 * yet, so there is nothing a Smart Fix byte change could invalidate. Any
 * modification to a document that HAS a real /V, however, would invalidate
 * that signature by definition (that is what a digital signature over the
 * document bytes is for) — this is not KDPSafe-specific, it's how PDF
 * signatures work, per smart-fix-engine-research.md §8.
 */
function hasSignatureField(doc) {
  const acroFormRef = doc.catalog.get(PDFName.of('AcroForm'));
  if (!acroFormRef) return false;
  const acroForm = doc.context.lookup(acroFormRef);
  if (!acroForm || typeof acroForm.lookup !== 'function') return false;

  const fieldsArray = acroForm.lookup(PDFName.of('Fields'));
  if (!fieldsArray || typeof fieldsArray.asArray !== 'function') return false;

  for (const fieldRef of fieldsArray.asArray()) {
    const field = doc.context.lookup(fieldRef);
    if (!field || typeof field.lookup !== 'function') continue;

    const ft = field.lookup(PDFName.of('FT'));
    const isSigField = !!(ft && typeof ft.asString === 'function' && ft.asString() === '/Sig');
    if (!isSigField) continue;

    const value = field.lookup(PDFName.of('V'));
    if (value) return true;
  }

  return false;
}

module.exports = { checkHardGate };
