'use strict';

/**
 * Smart Fix Phase 2 — dry-run margin re-check (requirement #5: "dry-run
 * через existing classifyViolations()").
 *
 * Rather than re-derive lib/zones.js/lib/zoneGeometry.js's zone math by
 * hand to simulate "would this transform pass margins", this reuses the
 * REAL, frozen lib/orchestrator.js::runPreflight() — which itself calls
 * classifyViolations() internally — against a throwaway, single-page copy
 * of the document with the candidate transform ALREADY applied via the
 * real writer (repairWriter.js). This is deliberately not a parallel
 * simulation: it is literally "apply for real, on a disposable copy, and
 * ask the frozen engine if it's happy" — the same engine, the same code
 * path, that the real apply()+re-preflight step uses. Any discrepancy
 * between this and the real multi-page apply is still caught by THAT
 * step's own mandatory re-preflight (see smartFixEngine.js::applyRepair()),
 * so this dry-run is a safety PRE-check, not the final word.
 *
 * Why single-page extraction, not the whole document: cheap, and it still
 * needs the ORIGINAL document's total page count passed in explicitly
 * (pageContext.pageCount) so the KDP gutter-margin lookup — which is keyed
 * on total page count, not the 1-page throwaway copy's count — matches
 * what the real multi-page re-preflight would see.
 */

const { PDFDocument } = require('pdf-lib');
const { runPreflight } = require('../orchestrator');
const { applyStrategyToPage } = require('./repairWriter');

/**
 * @param {Uint8Array} pdfBytes  the ORIGINAL, full document's bytes
 * @param {object} strategy  a candidate RepairStrategy (PADDING,
 *   PROPORTIONAL_SCALE, or SCALE_PLUS_PADDING) — never BOX_NORMALIZATION,
 *   which never moves content and therefore never needs a margin dry-run.
 * @param {object} pageAnalysis  this page's PageGeometryAnalysis
 * @param {object} userIntent
 * @returns {Promise<{ clean: boolean, result: object }>}
 */
async function dryRunContentTransform(pdfBytes, strategy, pageAnalysis, userIntent) {
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const single = await PDFDocument.create();
  const [copiedPage] = await single.copyPages(src, [pageAnalysis.pageIndex]);
  single.addPage(copiedPage);

  applyStrategyToPage(single, single.getPage(0), strategy, pageAnalysis);
  const transformedBytes = await single.save();

  const result = await runPreflight(transformedBytes, {
    userIntent,
    pageContext: { pageCount: pageAnalysis.totalPageCount },
  });

  const clean = result.categories.margins.violations.length === 0 && result.categories.margins.manualReview.length === 0;
  return { clean, result };
}

module.exports = { dryRunContentTransform };
