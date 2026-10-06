'use strict';

/**
 * Smart Fix type reference — JSDoc typedefs only, no runtime logic.
 * Mirrors the shapes defined in smart-fix-engine-mvp-architecture.md §2.
 * Phase 1 implements a narrow subset (see each file's own header for
 * exactly which fields are populated this phase); fields documented here
 * that aren't populated yet are reserved for Phase 2/3, never silently
 * repurposed.
 *
 * @typedef {object} PageGeometryProblem
 * @property {number} pageIndex
 * @property {'TOO_SMALL'|'TOO_LARGE'|'WRONG_ASPECT'|'MISSING_TRIM_BOX'|'MISSING_BLEED_BOX'|'NON_ZERO_ORIGIN'|'NON_ZERO_ROTATION'|'INCONSISTENT_PAGE_SIZE'|'BOX_CONFLICT'} kind
 * @property {string} detail
 * @property {{widthIn: number|null, heightIn: number|null}} measured
 * @property {{widthIn: number|null, heightIn: number|null}} expected
 *
 * @typedef {object} RepairRisk
 * @property {'SAFE_AUTOFIX'|'USER_CONFIRMATION'|'MANUAL_REVIEW'|'DO_NOT_TOUCH'} level
 * @property {string[]} reasons
 *
 * @typedef {object} RepairStrategy
 * @property {string} type
 * @property {Record<string, number|boolean>} params
 * @property {RepairRisk} risk
 * @property {string[]} guarantees
 * @property {string[]} preconditions
 *
 * @typedef {object} RepairPlan
 * @property {number} pageIndex
 * @property {PageGeometryProblem|null} problem
 * @property {RepairStrategy|null} chosenStrategy
 * @property {RepairStrategy[]} alternativeStrategies
 * @property {string} explanation  plain-language summary (Phase 1 addition,
 *   not yet in the architecture doc's bare interface — this is the
 *   "repair plan + explanation" deliverable this checkpoint asks for)
 *
 * @typedef {object} TransformDescriptor
 * Describes what WOULD be written, as plain data — Phase 1 never executes
 * this; no writer module exists yet. Shape is strategy-specific; see each
 * strategy module's buildTransform() for its own fields.
 */

module.exports = {};
