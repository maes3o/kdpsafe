'use strict';

/**
 * Shared page/trim/LEM/bleed geometry for the Margin/Bleed/LEM
 * detection-only tests (2026-10-05 stage). Numbers are deliberately
 * simple, round values picked for internal test consistency, not a
 * transcription of any specific real KDP trim size's official margin
 * table -- the parts that ARE implemented against KDP's own published
 * numbers already live in spine.js (BLEED_IN there matches BLEED_IN
 * here).
 *
 * Layout (all in points, PDF bottom-left origin), modeling a 6x9in trim
 * with the standard 0.125in bleed on every edge and a 0.5in LEM inset
 * from trim:
 *
 *   mediaBox (= bleedBoxPt)   0..450 x 0..666    <- the actual PDF page
 *     trimBoxPt               9..441 x 9..657    <- 9pt (0.125in) inside mediaBox
 *       safeZoneBBoxPt       45..405 x 45..621   <- 36pt (0.5in) inside trim
 */

const PT = 72;
const BLEED_IN = 0.125;
const LEM_IN = 0.5;
const TRIM_W_IN = 6;
const TRIM_H_IN = 9;

const bleedBoxPt = {
  minX: 0,
  minY: 0,
  maxX: (TRIM_W_IN + 2 * BLEED_IN) * PT,
  maxY: (TRIM_H_IN + 2 * BLEED_IN) * PT,
};

const trimBoxPt = {
  minX: BLEED_IN * PT,
  minY: BLEED_IN * PT,
  maxX: bleedBoxPt.maxX - BLEED_IN * PT,
  maxY: bleedBoxPt.maxY - BLEED_IN * PT,
};

const safeZoneBBoxPt = {
  minX: trimBoxPt.minX + LEM_IN * PT,
  minY: trimBoxPt.minY + LEM_IN * PT,
  maxX: trimBoxPt.maxX - LEM_IN * PT,
  maxY: trimBoxPt.maxY - LEM_IN * PT,
};

const zones = { trimBoxPt, safeZoneBBoxPt, bleedBoxPt };
const mediaBoxSize = [bleedBoxPt.maxX, bleedBoxPt.maxY];

module.exports = { PT, BLEED_IN, LEM_IN, bleedBoxPt, trimBoxPt, safeZoneBBoxPt, zones, mediaBoxSize };
