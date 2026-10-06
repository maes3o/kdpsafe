'use strict';

/**
 * Smart Fix Engine — public entry point.
 *
 * Phase 1 added planRepair() — entirely read-only. Phase 2 adds
 * applyRepair(): write -> mandatory re-preflight -> verify. Neither this
 * file nor anything it calls ever modifies the frozen engine (lib/
 * orchestrator.js, lib/autofix.js, lib/margin.js, lib/zones.js, lib/
 * zoneGeometry.js, lib/manuscript.js, lib/pdfAutofixWriter.js, lib/
 * geometryRewriter.js) or the frontend — runPreflight() is called, never
 * forked or reimplemented.
 *
 * Call sequence for planRepair(): checkHardGate() first, always — if it
 * blocks, nothing else in this module (or Smart Fix at all) runs for this
 * document. Only once the gate passes does analyzeDocumentGeometry() run
 * per page, and only then does repairPlanner.planPage() turn each page's
 * analysis into a RepairPlan.
 *
 * Call sequence for applyRepair(): re-check the hard gate against the
 * actual bytes -> planRepair() (never trusts a caller-supplied plan from
 * a previous call) -> runPreflight(before) -> repairWriter.
 * applyPlanToDocument() (the only step that writes bytes) ->
 * runPreflight(after) -> structural invariant checks -> verified
 * decision. `after` is always a genuine re-check of the real, written
 * output — never skipped, never assumed.
 */

const { checkHardGate } = require('./hardGate');
const { analyzeDocumentGeometry } = require('./geometryProblems');
const { planPage } = require('./repairPlanner');
const { applyPlanToDocument } = require('./repairWriter');
const { buildPreview } = require('./repairPreview');
const { runPreflight } = require('../orchestrator');
const { readPageAnnotationSafety } = require('./annotations');
const { PDFDocument } = require('pdf-lib');

/**
 * @param {Uint8Array} pdfBytes
 * @param {{trimSize:{widthIn:number,heightIn:number}, bleed:boolean}} userIntent
 * @returns {Promise<{
 *   documentStatus: 'DO_NOT_TOUCH' | 'ANALYZED',
 *   hardGate: { blocked: boolean, reasons: string[] },
 *   document?: { pageCount: number, pageSizeConsistent: boolean },
 *   plans: import('./types').RepairPlan[],
 *   explanation: string,
 * }>}
 */
async function planRepair(pdfBytes, userIntent) {
  const hardGate = await checkHardGate(pdfBytes);

  if (hardGate.blocked) {
    return {
      documentStatus: 'DO_NOT_TOUCH',
      hardGate,
      plans: [],
      explanation:
        `Документ не може бути обробленим Smart Fix: ${hardGate.reasons.join(', ')}. ` +
        'Жодна геометрична перевірка чи пропозиція виправлення не виконується для цього файлу — ' +
        'це безумовне правило (encryption/signature), а не рішення конкретної стратегії.',
    };
  }

  const docGeometry = await analyzeDocumentGeometry(pdfBytes, userIntent);
  const plans = await Promise.all(
    docGeometry.pages.map((pageAnalysis) => planPage(pageAnalysis.problem, pageAnalysis, userIntent))
  );

  return {
    documentStatus: 'ANALYZED',
    hardGate,
    document: {
      pageCount: docGeometry.pageCount,
      pageSizeConsistent: docGeometry.pageSizeConsistent,
    },
    pageAnalyses: docGeometry.pages,
    plans,
    preview: buildPreview(plans, docGeometry.pages),
    explanation: buildDocumentExplanation(plans, docGeometry),
  };
}

/**
 * Phase 2 — mandatory apply -> re-preflight -> verify pipeline
 * (requirement #7). This is the ONLY function in Smart Fix that produces
 * new, written-to PDF bytes outside of a disposable dry-run copy.
 *
 * Never claims VERIFIED on anything other than a fresh runPreflight() of
 * the ACTUALLY-WRITTEN output bytes — the dry-run step inside each scale
 * strategy's classify() (lib/smartfix/dryRun.js) is a pre-check on a
 * single-page throwaway copy, not a substitute for this real, whole-
 * document, post-write re-verification.
 *
 * @param {Uint8Array} pdfBytes
 * @param {object} userIntent
 * @param {{ confirmedPageIndexes?: number[], onProgress?: (stage: 'APPLYING'|'CHECKING') => void }} [opts]
 *   confirmedPageIndexes: pages whose USER_CONFIRMATION-level strategy the
 *   caller has had the user approve. SAFE_AUTOFIX-level strategies are
 *   always applied; MANUAL_REVIEW/DO_NOT_TOUCH/no-strategy pages are never
 *   touched, regardless of this.
 *   onProgress: OPTIONAL, purely informational callback for a caller (e.g.
 *   the frontend) that wants to show progress text. Fired 'APPLYING' right
 *   before bytes are written and 'CHECKING' right before the mandatory
 *   post-write re-preflight. Never affects behavior, timing, or the
 *   verified/reasons decision when omitted — a no-op additive hook, not a
 *   change to the safety model.
 * @returns {Promise<{
 *   documentStatus: 'DO_NOT_TOUCH'|'APPLIED',
 *   before: object|null, after: object|null, outputBytes: Uint8Array,
 *   appliedPageIndexes: number[], skipped: Array<{pageIndex:number, reason:string}>,
 *   invariants: object, verified: boolean, reasons: string[],
 * }>}
 */
async function applyRepair(pdfBytes, userIntent, opts = {}) {
  // Defensive re-check: applyRepair() is meant to be called with plans
  // from THIS SAME document's own planRepair() result, but never trusts
  // that blindly — the hard gate is re-evaluated against the actual bytes
  // about to be written, independent of whatever the caller's plans claim.
  const hardGate = await checkHardGate(pdfBytes);
  if (hardGate.blocked) {
    return {
      documentStatus: 'DO_NOT_TOUCH',
      before: null,
      after: null,
      outputBytes: pdfBytes,
      appliedPageIndexes: [],
      skipped: [],
      invariants: null,
      verified: false,
      reasons: [`DO_NOT_TOUCH: ${hardGate.reasons.join(', ')}`],
    };
  }

  const planResult = await planRepair(pdfBytes, userIntent);
  const before = await runPreflight(pdfBytes, { userIntent });
  const beforeDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const beforeAnnotationCounts = beforeDoc.getPages().map((p) => readPageAnnotationSafety(beforeDoc, p).count);

  if (typeof opts.onProgress === 'function') opts.onProgress('APPLYING');

  const { outputBytes, appliedPageIndexes, skipped } = await applyPlanToDocument(
    pdfBytes,
    planResult.plans,
    planResult.pageAnalyses,
    opts
  );

  if (typeof opts.onProgress === 'function') opts.onProgress('CHECKING');

  const after = await runPreflight(outputBytes, { userIntent });
  const afterDoc = await PDFDocument.load(outputBytes, { ignoreEncryption: true });
  const afterAnnotationCounts = afterDoc.getPages().map((p) => readPageAnnotationSafety(afterDoc, p).count);

  const invariants = computeSmartFixInvariants({
    before,
    after,
    beforeAnnotationCounts,
    afterAnnotationCounts,
    appliedPageIndexes,
  });

  const { verified, reasons } = computeVerified(after, invariants, appliedPageIndexes);

  // Informational only — never flips `verified`. A page skipped because
  // its USER_CONFIRMATION-tier strategy wasn't in opts.confirmedPageIndexes
  // was never claimed fixed in the first place; its own BEFORE state
  // (still whatever runPreflight(before) found for it) is unchanged and
  // unaffected by this document's verified/reasons outcome.
  const notes = [];
  if (skipped.some((s) => s.reason === 'MANUAL_REVIEW')) notes.push('SOME_PAGES_MANUAL_REVIEW_NOT_TOUCHED');
  if (skipped.some((s) => s.reason.startsWith('NOT_CONFIRMED_'))) notes.push('SOME_PAGES_SKIPPED_NOT_CONFIRMED_BY_USER');

  return {
    documentStatus: 'APPLIED',
    before,
    after,
    outputBytes,
    appliedPageIndexes,
    skipped,
    invariants,
    verified,
    reasons,
    notes,
  };
}

/**
 * Smart Fix-specific structural invariants, checked against the REAL
 * before/after runPreflight() results of the REAL written bytes — never
 * against the dry-run's single-page throwaway copy.
 */
function computeSmartFixInvariants({ before, after, beforeAnnotationCounts, afterAnnotationCounts, appliedPageIndexes }) {
  const pageCountPreserved = before.document.pageCount === after.document.pageCount;

  // Annotation count is checked only on pages Smart Fix actually touched —
  // an untouched page's annotation count is irrelevant here (it was never
  // supposed to change either way, but a document-wide total comparison
  // would mask a per-page bug behind an unrelated page's own count).
  const annotationCountPreserved = appliedPageIndexes.every(
    (pageIndex) => beforeAnnotationCounts[pageIndex] === afterAnnotationCounts[pageIndex]
  );

  return { pageCountPreserved, annotationCountPreserved };
}

function computeVerified(after, invariants, appliedPageIndexes) {
  const reasons = [];
  if (!invariants.pageCountPreserved) reasons.push('PAGE_COUNT_CHANGED');
  if (!invariants.annotationCountPreserved) reasons.push('ANNOTATION_COUNT_CHANGED');

  // The authoritative check (per "якщо verification не проходить —
  // результат НЕ може бути VERIFIED"): every page Smart Fix actually
  // applied a transform to must show ZERO margin violations in the REAL,
  // post-write re-preflight — not merely in the earlier dry-run.
  const newViolationsOnAppliedPages = after.violations.filter((v) => appliedPageIndexes.includes(v.pageIndex));
  if (newViolationsOnAppliedPages.length > 0) reasons.push('VIOLATIONS_REMAIN_AFTER_APPLY_ON_APPLIED_PAGES');

  const manualReviewOnAppliedPages = after.categories.margins.manualReview.filter((m) => appliedPageIndexes.includes(m.pageIndex));
  if (manualReviewOnAppliedPages.length > 0) reasons.push('MANUAL_REVIEW_REMAINS_AFTER_APPLY_ON_APPLIED_PAGES');

  return { verified: reasons.length === 0, reasons };
}

function buildDocumentExplanation(plans, docGeometry) {
  const counts = { SAFE_AUTOFIX: 0, USER_CONFIRMATION: 0, MANUAL_REVIEW: 0, NONE: 0 };
  for (const plan of plans) {
    if (plan.chosenStrategy) counts[plan.chosenStrategy.risk.level]++;
    else if (plan.problem) counts.MANUAL_REVIEW++;
    else counts.NONE++;
  }

  const parts = [`${docGeometry.pageCount} стор.`];
  if (!docGeometry.pageSizeConsistent) {
    parts.push('розміри сторінок неоднакові (кожна сторінка проаналізована й запланована окремо, незалежно від інших).');
  }
  parts.push(
    `SAFE_AUTOFIX: ${counts.SAFE_AUTOFIX}, USER_CONFIRMATION: ${counts.USER_CONFIRMATION}, ` +
      `MANUAL_REVIEW: ${counts.MANUAL_REVIEW}, без змін: ${counts.NONE}.`
  );
  return parts.join(' ');
}

module.exports = { planRepair, applyRepair };
