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
// Phase 2 adds TOO_LARGE/WRONG_ASPECT: PROPORTIONAL_SCALE/SCALE_PLUS_PADDING
// are the strategies that now target those problem kinds (their own
// detect() preconditions are the real gate — rotation/non-zero-origin/
// box-conflict pages never reach TOO_LARGE/WRONG_ASPECT in the first
// place, since geometryProblems.js's if/else chain gives those problem
// kinds priority — see that module's header).
const STRATEGY_TARGETABLE_PROBLEM_KINDS = new Set(['TOO_SMALL', 'TOO_LARGE', 'WRONG_ASPECT']);

/**
 * @param {import('./types').PageGeometryProblem|null} problem
 * @param {import('./geometryProblems').PageGeometryAnalysis} pageAnalysis
 * @param {object} userIntent
 * @returns {Promise<import('./types').RepairStrategy[]>} candidates, each with risk already classified
 */
async function generateCandidates(problem, pageAnalysis, userIntent) {
  const candidates = [];
  for (const strategyModule of registry) {
    const strategy = strategyModule.detect(problem, pageAnalysis, userIntent);
    if (!strategy) continue;

    // Phase 2 strategies' classify() does I/O (dry-run via runPreflight(),
    // image detection) and returns a Promise; Phase 1 strategies' classify()
    // is a plain sync function. `await` on a non-Promise value is a no-op,
    // so this one line handles both generically without a type check.
    strategy.risk = await strategyModule.classify(strategy, pageAnalysis, userIntent);
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
function applyCentralSafetyOverride(problem, candidates, pageAnalysis) {
  let survivors = candidates;

  if (problem !== null && !STRATEGY_TARGETABLE_PROBLEM_KINDS.has(problem.kind)) {
    // Any other non-null problem kind: no candidate may survive, however
    // it classified itself. (In Phase 1 this is unreachable via the
    // registered strategies' own preconditions — detect() already returns
    // null for every other problem kind — but the override exists so that
    // remains true by construction, not by convention.)
    return [];
  }

  // Phase 2 defense-in-depth: a page with an annotation Smart Fix cannot
  // safely re-geometry (see annotations.js) must never have a content-
  // MOVING strategy survive, regardless of what that strategy's own
  // classify() decided — BOX_NORMALIZATION is exempt because it never
  // touches content or annotations at all. Each scale strategy's own
  // classify() already checks this too (so a direct call bypassing the
  // planner is still safe); this is the second, structural layer, exactly
  // mirroring how the problem-kind override above backs up each
  // strategy's own detect() precondition.
  if (pageAnalysis && pageAnalysis.annotations && pageAnalysis.annotations.unsafeToTransform) {
    survivors = survivors.filter((c) => c.type === 'BOX_NORMALIZATION');
  }

  return survivors;
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
// Risk levels a candidate must carry to ever become chosenStrategy/an
// alternative. Phase 1 strategies' classify() never returns anything else;
// Phase 2's scale strategies CAN self-classify as MANUAL_REVIEW (dry-run
// failed, unsafe annotation, insufficient DPI) — such a candidate is not
// "a strategy that was proposed", it is the strategy module itself
// confirming it found no safe way to act, which must collapse to the same
// chosenStrategy===null / MANUAL_REVIEW outcome as if it had never
// detect()-ed a candidate at all.
const ACTIONABLE_RISK_LEVELS = new Set(['SAFE_AUTOFIX', 'USER_CONFIRMATION']);

async function planPage(problem, pageAnalysis, userIntent) {
  const rawCandidates = await generateCandidates(problem, pageAnalysis, userIntent);
  const safeCandidates = applyCentralSafetyOverride(problem, rawCandidates, pageAnalysis);
  const actionable = safeCandidates.filter((c) => ACTIONABLE_RISK_LEVELS.has(c.risk.level));
  const selfDeclaredUnsafe = safeCandidates.filter((c) => !ACTIONABLE_RISK_LEVELS.has(c.risk.level));
  const ranked = rank(actionable);

  const chosenStrategy = ranked.length > 0 ? ranked[0] : null;
  const alternativeStrategies = ranked.slice(1);

  const explanation = buildExplanation(problem, pageAnalysis, chosenStrategy, selfDeclaredUnsafe);

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

function buildExplanation(problem, pageAnalysis, chosenStrategy, selfDeclaredUnsafe = []) {
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
  const selfDeclaredPart = selfDeclaredUnsafe.length > 0
    ? ` Стратегі(я/ї) ${selfDeclaredUnsafe.map((c) => c.type).join(', ')} розглядалися, але сама(і) класифікувалися як MANUAL_REVIEW: ${selfDeclaredUnsafe.flatMap((c) => c.risk.reasons).join('; ')}.`
    : '';
  return (
    `Сторінка ${pageAnalysis.pageIndex + 1}: ${problem.detail} ` +
    `Жодна стратегія не може безпечно й доказово виправити це автоматично — потрібен ручний розгляд (MANUAL_REVIEW).${selfDeclaredPart}`
  );
}

module.exports = { generateCandidates, rank, applyCentralSafetyOverride, planPage };
