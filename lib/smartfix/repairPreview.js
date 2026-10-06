'use strict';

/**
 * Smart Fix Phase 2 — Before -> After PREVIEW DATA (requirement #6).
 *
 * Deliberately data-only, not a rendered image: no PDF rasterization
 * library is wired into this project, and building one is a separate,
 * much larger undertaking (a frontend/rendering concern, not part of this
 * checkpoint's scope). What this module provides is the structured
 * before/after description a UI needs to RENDER that comparison —
 * dimensions, what strategy would run, what it guarantees, and the risk
 * tier — matching smart-fix-engine-mvp-architecture.md §2's own Preview
 * step, which calls for exactly this shape of data ahead of any UI work.
 */

/**
 * @param {import('./types').RepairPlan[]} plans
 * @param {import('./geometryProblems').PageGeometryAnalysis[]} pageAnalyses
 * @returns {Array<object>} one preview entry per page
 */
function buildPreview(plans, pageAnalyses) {
  return plans.map((plan) => {
    const pageAnalysis = pageAnalyses.find((p) => p.pageIndex === plan.pageIndex);
    const before = {
      widthIn: pageAnalysis.measured.widthIn,
      heightIn: pageAnalysis.measured.heightIn,
      problem: plan.problem ? plan.problem.kind : null,
    };

    if (!plan.chosenStrategy) {
      return { pageIndex: plan.pageIndex, before, after: null, strategyType: null, riskLevel: plan.problem ? 'MANUAL_REVIEW' : 'NONE', guarantees: [], explanation: plan.explanation };
    }

    const targetWidthPt = plan.chosenStrategy.params.targetWidthPt;
    const targetHeightPt = plan.chosenStrategy.params.targetHeightPt;

    return {
      pageIndex: plan.pageIndex,
      before,
      after: {
        widthIn: targetWidthPt / 72,
        heightIn: targetHeightPt / 72,
      },
      strategyType: plan.chosenStrategy.type,
      riskLevel: plan.chosenStrategy.risk.level,
      guarantees: plan.chosenStrategy.guarantees,
      explanation: plan.explanation,
    };
  });
}

module.exports = { buildPreview };
