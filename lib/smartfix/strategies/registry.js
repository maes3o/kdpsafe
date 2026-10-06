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
 * Phase 1 deliberately registers only the two zero/near-zero-content-risk
 * strategies. SAFE_CROP/PROPORTIONAL_SCALE/SCALE_PLUS_PADDING are
 * explicitly excluded from this phase per the checkpoint instruction —
 * not because the registry can't hold them, but because their
 * classify()/precondition logic (dry-run margin re-check, DPI estimation,
 * content-empty proof) isn't built yet. Adding them later is additive.
 */

const BOX_NORMALIZATION = require('./boxNormalization');
const PADDING = require('./padding');

module.exports = [BOX_NORMALIZATION, PADDING];
