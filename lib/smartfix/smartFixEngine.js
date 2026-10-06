'use strict';

/**
 * Smart Fix Engine — Phase 1 public entry point.
 *
 * Phase 1 scope, deliberately: planRepair() ONLY. No previewRepair(),
 * applyRepair(), or verifyRepair() exist yet — this phase is entirely
 * read-only, as instructed. Nothing in this file, or anything it calls,
 * writes a single byte to the input PDF, and nothing in the frozen
 * engine (lib/orchestrator.js, lib/autofix.js, lib/margin.js, lib/zones
 * .js, lib/zoneGeometry.js, lib/manuscript.js, lib/pdfAutofixWriter.js,
 * lib/geometryRewriter.js) or the frontend is modified or forked.
 *
 * Call sequence: checkHardGate() first, always — if it blocks, nothing
 * else in this module (or Smart Fix at all) runs for this document. Only
 * once the gate passes does analyzeDocumentGeometry() run per page, and
 * only then does repairPlanner.planPage() turn each page's analysis into
 * a RepairPlan.
 */

const { checkHardGate } = require('./hardGate');
const { analyzeDocumentGeometry } = require('./geometryProblems');
const { planPage } = require('./repairPlanner');

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
  const plans = docGeometry.pages.map((pageAnalysis) => planPage(pageAnalysis.problem, pageAnalysis, userIntent));

  return {
    documentStatus: 'ANALYZED',
    hardGate,
    document: {
      pageCount: docGeometry.pageCount,
      pageSizeConsistent: docGeometry.pageSizeConsistent,
    },
    plans,
    explanation: buildDocumentExplanation(plans, docGeometry),
  };
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

module.exports = { planRepair };
