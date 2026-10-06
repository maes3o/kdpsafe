'use strict';

/**
 * BOX_NORMALIZATION strategy module — see smart-fix-engine-research.md
 * §3.1 and smart-fix-engine-mvp-architecture.md §2.2 for the full
 * contract. Writes/corrects /TrimBox and /BleedBox only — never touches
 * the content stream. This is the only strategy whose mechanical risk
 * ceiling is zero content risk by construction, so it is the only one
 * Phase 1 classifies as SAFE_AUTOFIX unconditionally.
 *
 * Phase 1: detect()/classify()/describe() are fully implemented and
 * read-only. buildTransform() returns a plain descriptor (what WOULD be
 * written) — nothing in this module performs any I/O; no writer consumes
 * this descriptor yet.
 */

const TYPE = 'BOX_NORMALIZATION';
const CONTENT_PRESERVING = true;

/**
 * @param {import('../types').PageGeometryProblem|null} problem
 * @param {import('../geometryProblems').PageGeometryAnalysis} pageAnalysis
 * @param {{trimSize:{widthIn:number,heightIn:number}, bleed:boolean}} userIntent
 * @returns {import('../types').RepairStrategy|null}
 */
function detect(problem, pageAnalysis, userIntent) {
  // Mechanically inapplicable whenever the page isn't ALREADY the right
  // size — box normalization can only describe a canvas that's already
  // correctly sized (smart-fix-engine-research.md §3.1, "when it does NOT
  // apply").
  if (pageAnalysis.sizeRelation !== 'EXACT') return null;

  // Any flagged problem on this page (rotation, non-zero origin, a
  // conflicting explicit box) blocks EVERY strategy, box normalization
  // included — writing a fresh /TrimBox over a page whose own explicit,
  // disagreeing /TrimBox hasn't been resolved would be guessing, not
  // fixing.
  if (problem !== null) return null;

  const needsTrimBox = pageAnalysis.trimBoxCheck.status === 'absent';
  const needsBleedBox = !!(userIntent && userIntent.bleed) && pageAnalysis.bleedBoxCheck.status === 'absent';

  if (!needsTrimBox && !needsBleedBox) {
    // Already fully compliant (box dims present and consistent, or bleed
    // not requested) — nothing to declare, no candidate needed.
    return null;
  }

  return {
    type: TYPE,
    params: {
      writeTrimBox: needsTrimBox,
      writeBleedBox: needsBleedBox,
      targetWidthPt: pageAnalysis.target.widthPt,
      targetHeightPt: pageAnalysis.target.heightPt,
    },
    risk: null, // filled by classify()
    guarantees: [],
    preconditions: [],
  };
}

/**
 * @param {import('../types').RepairStrategy} strategy
 * @returns {import('../types').RepairRisk}
 */
function classify(strategy) {
  return {
    level: 'SAFE_AUTOFIX',
    reasons: [
      'Торкається лише словника сторінки (/TrimBox та/або /BleedBox) — контент-стрім і всі намальовані об’єкти лишаються байт-в-байт незмінними.',
      'MediaBox сторінки вже точно відповідає цільовому розміру — декларація лише описує те, що вже фактично так.',
    ],
  };
}

function describe(strategy) {
  const guarantees = [
    'Контент (текст, зображення, вектори, анотації) не змінюється й не переміщується.',
    'Жодної трансформації координат не виконується.',
  ];
  if (strategy.params.writeTrimBox) {
    guarantees.push('Додається коректний /TrimBox, що відповідає підтвердженому trim-розміру.');
  }
  if (strategy.params.writeBleedBox) {
    guarantees.push('Додається коректний /BleedBox, що відповідає підтвердженому bleed-вибору.');
  }
  return {
    guarantees,
    preconditions: [
      'Поточний розмір MediaBox вже точно (у межах допуску) відповідає цільовому trim(+bleed) розміру.',
      'Явний /TrimBox (якщо присутній) узгоджується з цим розміром; явний /BleedBox (якщо bleed потрібен і присутній) теж узгоджується — інакше ця стратегія не пропонується.',
    ],
  };
}

/**
 * Descriptor only — no bytes are written in Phase 1. A future
 * repairWriter.js (Phase 2+) would consume this shape.
 */
function buildTransform(strategy) {
  return {
    kind: 'BOX_DICT_ONLY',
    writeTrimBox: strategy.params.writeTrimBox,
    writeBleedBox: strategy.params.writeBleedBox,
    targetWidthPt: strategy.params.targetWidthPt,
    targetHeightPt: strategy.params.targetHeightPt,
  };
}

module.exports = { type: TYPE, contentPreserving: CONTENT_PRESERVING, detect, classify, describe, buildTransform };
