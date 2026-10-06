'use strict';

/**
 * PADDING strategy module — see smart-fix-engine-research.md §3.2 and
 * smart-fix-engine-mvp-architecture.md §2.2. Enlarges the canvas and
 * re-centers existing content; never scales, never crops, never touches
 * a pixel/vector's shape. Safe for ANY aspect-ratio relationship, as long
 * as EVERY axis needs to grow (or stay the same) — it is purely additive,
 * so aspect ratio (report 1 §4's concern, which is specifically about
 * SCALE operations) does not apply to it at all.
 *
 * Phase 1: detect()/classify()/describe() are fully implemented and
 * read-only. buildTransform() returns a plain descriptor; no writer
 * exists yet in this phase (PROPORTIONAL_SCALE/SCALE_PLUS_PADDING/
 * SAFE_CROP are explicitly out of scope for Phase 1 — see
 * repairPlanner.js).
 */

const TYPE = 'PADDING';
const CONTENT_PRESERVING = true;

// From smart-fix-engine-research.md §11.2's own worked example: a deficit
// of ~0.05in on an axis is "likely export rounding" (SAFE_AUTOFIX); a
// deficit around 2in is "clearly a different-trim-size file" and must be
// shown to the user first. 0.05in is used here as the literal, explicit
// threshold from that report, not a newly invented number.
const SAFE_AUTOFIX_MAX_PAD_IN = 0.05;
// Floating-point guard only (not a policy fudge-factor): a deficit
// computed from in->pt->in round-tripping can land a few 1e-13in off the
// literal 0.05in boundary either way. Without this, a fixture built as
// "exactly 0.05in short" could nondeterministically classify as
// SAFE_AUTOFIX or USER_CONFIRMATION depending on float rounding noise —
// the threshold itself stays exactly 0.05in, this only makes the
// comparison robust to representation error.
const FLOAT_EPSILON_IN = 1e-9;

/**
 * @param {import('../types').PageGeometryProblem|null} problem
 * @param {import('../geometryProblems').PageGeometryAnalysis} pageAnalysis
 * @returns {import('../types').RepairStrategy|null}
 */
function detect(problem, pageAnalysis) {
  if (pageAnalysis.sizeRelation !== 'TOO_SMALL') return null;

  // The only safe reading of "TOO_SMALL" for this strategy is when the
  // detector's own problem-classification agrees it's TOO_SMALL and
  // nothing else (rotation, non-zero origin, a conflicting explicit box)
  // was flagged first — those take priority and block every strategy.
  if (!problem || problem.kind !== 'TOO_SMALL') return null;

  const padWidthPt = -pageAnalysis.deltaWidthPt; // >= 0 by construction of TOO_SMALL
  const padHeightPt = -pageAnalysis.deltaHeightPt;

  return {
    type: TYPE,
    params: {
      targetWidthPt: pageAnalysis.target.widthPt,
      targetHeightPt: pageAnalysis.target.heightPt,
      padWidthTotalPt: padWidthPt,
      padHeightTotalPt: padHeightPt,
      anchor: 'center',
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
  const padWidthIn = strategy.params.padWidthTotalPt / 72;
  const padHeightIn = strategy.params.padHeightTotalPt / 72;
  const maxPadIn = Math.max(padWidthIn, padHeightIn);

  if (maxPadIn <= SAFE_AUTOFIX_MAX_PAD_IN + FLOAT_EPSILON_IN) {
    return {
      level: 'SAFE_AUTOFIX',
      reasons: [
        `Потрібне доповнення (${maxPadIn.toFixed(3)}in) не перевищує ${SAFE_AUTOFIX_MAX_PAD_IN}in — ймовірно похибка експорту, а не інший trim-розмір.`,
        'Контент лише доповнюється порожнім полотном — жоден існуючий об’єкт не змінюється.',
      ],
    };
  }

  return {
    level: 'USER_CONFIRMATION',
    reasons: [
      `Потрібне доповнення (${maxPadIn.toFixed(3)}in) помітне — користувач повинен побачити BEFORE/AFTER перед застосуванням.`,
      'Контент не змінюється, але композиція сторінки візуально змінюється (більше порожнього поля).',
    ],
  };
}

function describe() {
  return {
    guarantees: [
      'Жоден існуючий піксель чи вектор не видаляється, не обрізається і не масштабується.',
      'Вміст центрується в межах нового, більшого полотна (лише додається порожнє поле).',
      'Результатом також буде коректна декларація /TrimBox та, якщо потрібно, /BleedBox для нового розміру.',
    ],
    preconditions: [
      'Сторінка менша або дорівнює цільовому розміру на КОЖНІЙ осі (ніколи не пропонується, якщо потрібне зменшення хоч на одній осі).',
      'Немає конфліктуючого явного /TrimBox чи /BleedBox, немає ненульової ротації чи ненульового походження MediaBox.',
    ],
  };
}

/**
 * Descriptor only — no bytes are written in Phase 1.
 */
function buildTransform(strategy) {
  const dx = strategy.params.padWidthTotalPt / 2;
  const dy = strategy.params.padHeightTotalPt / 2;
  return {
    kind: 'CONTENT_STREAM_WRAP_PLUS_BOX',
    dx,
    dy,
    targetWidthPt: strategy.params.targetWidthPt,
    targetHeightPt: strategy.params.targetHeightPt,
  };
}

module.exports = { type: TYPE, contentPreserving: CONTENT_PRESERVING, detect, classify, describe, buildTransform };
