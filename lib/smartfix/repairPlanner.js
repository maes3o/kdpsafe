'use strict';

/**
 * Smart Repair Planner — generates candidate strategies for one page via
 * strategies/registry.js (never by name), applies the central safety
 * override, ranks survivors, and builds the final per-page RepairPlan.
 * Read-only: calls only detect()/classify()/describe() on each registered
 * strategy module, never buildTransform() (that is reserved for a future
 * apply path — see smart-fix-engine-mvp-architecture.md §3 step 9, not
 * part of Phase 1).
 *
 * SAFETY OVER COVERAGE, concretely, in code: the override in
 * applyCentralSafetyOverride() below is what makes it structurally
 * impossible for a careless future strategy module to bypass the safety
 * floor — even if some new module's own classify() returned
 * SAFE_AUTOFIX/USER_CONFIRMATION, a page carrying an unresolved
 * PageGeometryProblem (rotation, non-zero origin, a conflicting explicit
 * box, an unsafe size relation, or missing userIntent) is forced to
 * MANUAL_REVIEW here, centrally, once — not re-implemented per strategy.
 */

const registry = require('./strategies/registry');

// Problem kinds a Phase-1 strategy is allowed to have already accounted
// for in its own detect() (i.e. the problem the chosen strategy TARGETS).
// Any OTHER non-null problem kind on the page always forces MANUAL_REVIEW,
// regardless of what any candidate's own classify() says.
const STRATEGY_TARGETABLE_PROBLEM_KINDS = new Set(['TOO_SMALL']);

/**
 * @param {import('./types').PageGeometryProblem|null} problem
 * @param {import('./geometryProblems').PageGeometryAnalysis} pageAnalysis
 * @param {object} userIntent
 * @returns {import('./types').RepairStrategy[]} candidates, each with risk already classified
 */
function generateCandidates(problem, pageAnalysis, userIntent) {
  const candidates = [];
  for (const strategyModule of registry) {
    const strategy = strategyModule.detect(problem, pageAnalysis, userIntent);
    if (!strategy) continue;

    strategy.risk = strategyModule.classify(strategy, pageAnalysis);
    const described = strategyModule.describe(strategy, pageAnalysis);
    strategy.guarantees = described.guarantees;
    strategy.preconditions = described.preconditions;
    strategy.contentPreserving = strategyModule.contentPreserving;

    candidates.push(strategy);
  }
  return candidates;
}

/**
 * Content-preserving candidates always outrank non-content-preserving
 * ones (categorical, never a magnitude tie-break — smart-fix-engine-
 * gap-closure.md §B). Within a tier, the smallest visual delta wins. In
 * Phase 1 every registered strategy is content-preserving and at most one
 * can ever be generated for a given page (BOX_NORMALIZATION and PADDING
 * have mutually exclusive preconditions — EXACT vs TOO_SMALL), so ranking
 * is a no-op in practice today; it is still implemented generically here
 * because Phase 2/3 strategies (SAFE_CROP in particular) will need it.
 *
 * @param {import('./types').RepairStrategy[]} candidates
 * @returns {import('./types').RepairStrategy[]}
 */
function rank(candidates) {
  return [...candidates].sort((a, b) => {
    if (a.contentPreserving !== b.contentPreserving) {
      return a.contentPreserving ? -1 : 1;
    }
    // Smallest visual delta wins, approximated generically by the largest
    // numeric magnitude found in `params` (works for PADDING's pad
    // amounts today; a future strategy defines its own comparable
    // magnitude the same way).
    const magnitude = (s) => Math.max(0, ...Object.values(s.params).filter((v) => typeof v === 'number').map(Math.abs));
    return magnitude(a) - magnitude(b);
  });
}

/**
 * The central safety floor. Returns the FINAL list of candidates allowed
 * to carry their own classify()-assigned risk level — every other
 * candidate (there should never be any, given each strategy's own
 * detect() preconditions, but this is defense-in-depth, not trust) is
 * dropped rather than silently kept.
 */
function applyCentralSafetyOverride(problem, candidates) {
  if (problem === null) return candidates;
  if (STRATEGY_TARGETABLE_PROBLEM_KINDS.has(problem.kind)) return candidates;
  // Any other non-null problem kind: no candidate may survive, however it
  // classified itself. (In Phase 1 this is unreachable via the registered
  // strategies' own preconditions — detect() already returns null for
  // every other problem kind — but the override exists so that remains
  // true by construction, not by convention.)
  return [];
}

/**
 * Builds the final RepairPlan for one page, including a plain-language
 * explanation (the "repair plan + explanation" deliverable for this
 * checkpoint).
 *
 * @param {import('./types').PageGeometryProblem|null} problem
 * @param {import('./geometryProblems').PageGeometryAnalysis} pageAnalysis
 * @param {object} userIntent
 * @returns {import('./types').RepairPlan}
 */
function planPage(problem, pageAnalysis, userIntent) {
  const rawCandidates = generateCandidates(problem, pageAnalysis, userIntent);
  const safeCandidates = applyCentralSafetyOverride(problem, rawCandidates);
  const ranked = rank(safeCandidates);

  const chosenStrategy = ranked.length > 0 ? ranked[0] : null;
  const alternativeStrategies = ranked.slice(1);

  const explanation = buildExplanation(problem, pageAnalysis, chosenStrategy);

  return {
    pageIndex: pageAnalysis.pageIndex,
    problem,
    chosenStrategy,
    alternativeStrategies,
    explanation,
  };
}

function inFmt(valueIn) {
  return typeof valueIn === 'number' ? `${valueIn.toFixed(3)}in` : 'н/д';
}

function buildExplanation(problem, pageAnalysis, chosenStrategy) {
  if (problem === null && chosenStrategy === null) {
    return `Сторінка ${pageAnalysis.pageIndex + 1}: вже відповідає цільовому розміру (${inFmt(pageAnalysis.measured.widthIn)} × ${inFmt(pageAnalysis.measured.heightIn)}), декларація боксів коректна. Жодної дії не потрібно.`;
  }

  if (chosenStrategy) {
    const levelLabel = {
      SAFE_AUTOFIX: 'безпечне автоматичне виправлення',
      USER_CONFIRMATION: 'виправлення, що потребує підтвердження користувача',
    }[chosenStrategy.risk.level] || chosenStrategy.risk.level;

    // problem can legitimately be null here (e.g. BOX_NORMALIZATION: page
    // is already the exact right size, nothing "wrong", just a missing
    // box declaration to add) — never read problem.detail without
    // checking.
    const problemPart = problem ? `${problem.detail} ` : 'Розмір сторінки вже коректний, але декларація боксів неповна. ';

    return (
      `Сторінка ${pageAnalysis.pageIndex + 1}: ${problemPart}` +
      `Пропонована стратегія: ${chosenStrategy.type} (${levelLabel}). ` +
      `Гарантії: ${chosenStrategy.guarantees.join('; ')}.`
    );
  }

  // problem !== null and no strategy survived -> MANUAL_REVIEW.
  return (
    `Сторінка ${pageAnalysis.pageIndex + 1}: ${problem.detail} ` +
    `Жодна стратегія Phase 1 (BOX_NORMALIZATION, PADDING) не може безпечно й доказово виправити це автоматично — потрібен ручний розгляд (MANUAL_REVIEW).`
  );
}

module.exports = { generateCandidates, rank, applyCentralSafetyOverride, planPage };
