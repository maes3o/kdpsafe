'use strict';

/**
 * The ONLY place Smart Fix strategies are enumerated. repairPlanner.js,
 * and any future preview/writer module, iterate this list generically —
 * none of them contain a strategy-type literal anywhere. Adding a new
 * strategy (Phase 2/3: PROPORTIONAL_SCALE, SCALE_PLUS_PADDING, SAFE_CROP,
 * ADDING_BLEED, …) means writing one new module implementing the same
 * four-function contract (see any file in this directory) and adding one
 * line here — nothing else in the pipeline changes.
 *
 * Phase 1 registered only the two zero/near-zero-content-risk strategies
 * (BOX_NORMALIZATION, PADDING). Phase 2 adds PROPORTIONAL_SCALE and
 * SCALE_PLUS_PADDING (their classify() is async — see repairPlanner.js's
 * generateCandidates(), which awaits every candidate's classify() result
 * generically, whether sync or async). SAFE_CROP remains explicitly
 * excluded — not started this phase.
 */

const BOX_NORMALIZATION = require('./boxNormalization');
const PADDING = require('./padding');
const PROPORTIONAL_SCALE = require('./proportionalScale');
const SCALE_PLUS_PADDING = require('./scalePlusPadding');

module.exports = [BOX_NORMALIZATION, PADDING, PROPORTIONAL_SCALE, SCALE_PLUS_PADDING];
