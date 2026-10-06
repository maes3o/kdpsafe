'use strict';

/**
 * SCALE_PLUS_PADDING — the general case: shrink by the binding axis's
 * ratio (never distorting aspect ratio), then pad the other axis's
 * remaining deficit to land exactly on target. See scaleMath.js for the
 * shared formula and the proof that this phase's own detect() paths never
 * produce an enlarge-direction (scaleFactor > 1) transform.
 */

const { TOLERANCE_PT } = require('../../margin');
const { computeScalePlusPadding } = require('../scaleMath');
const { dryRunContentTransform } = require('../dryRun');
const { assessUpscaleDpiRisk } = require('../dpiEstimator');

const TYPE = 'SCALE_PLUS_PADDING';
const CONTENT_PRESERVING = true;

const SCALE_TARGETABLE_KINDS = new Set(['TOO_LARGE', 'WRONG_ASPECT']);

function detect(problem, pageAnalysis) {
  if (!problem || !SCALE_TARGETABLE_KINDS.has(problem.kind)) return null;
  if (!pageAnalysis.target) return null;

  const measuredWidthPt = pageAnalysis.measured.widthIn * 72;
  const measuredHeightPt = pageAnalysis.measured.heightIn * 72;
  const scaled = computeScalePlusPadding(measuredWidthPt, measuredHeightPt, pageAnalysis.target.widthPt, pageAnalysis.target.heightPt);

  // This strategy handles everything proportionalScale.js's detect()
  // doesn't: i.e. at least one axis needs real (> TOLERANCE_PT) padding
  // after the uniform scale.
  if (Math.abs(scaled.padWidthTotalPt) <= TOLERANCE_PT && Math.abs(scaled.padHeightTotalPt) <= TOLERANCE_PT) return null;

  return {
    type: TYPE,
    params: {
      scaleFactor: scaled.scaleFactor,
      dx: scaled.dx,
      dy: scaled.dy,
      padWidthTotalPt: scaled.padWidthTotalPt,
      padHeightTotalPt: scaled.padHeightTotalPt,
      targetWidthPt: pageAnalysis.target.widthPt,
      targetHeightPt: pageAnalysis.target.heightPt,
    },
    risk: null,
    guarantees: [],
    preconditions: [],
  };
}

async function classify(strategy, pageAnalysis, userIntent) {
  if (pageAnalysis.annotations && pageAnalysis.annotations.unsafeToTransform) {
    return {
      level: 'MANUAL_REVIEW',
      reasons: ['Сторінка містить анотацію(ї) зі складною геометрією (QuadPoints/Vertices/InkList) — безпечна трансформація неможлива.', ...pageAnalysis.annotations.unsafeReasons],
    };
  }

  const { analyzePageObjects } = require('../../margin');
  const objects = await analyzePageObjects(pageAnalysis.pdfBytes, pageAnalysis.pageIndex);
  const hasRasterImages = objects.some((o) => o.type === 'image');
  const dpiRisk = assessUpscaleDpiRisk({ hasRasterImages, scaleFactor: strategy.params.scaleFactor });
  if (!dpiRisk.safe) {
    return { level: 'MANUAL_REVIEW', reasons: [dpiRisk.reason] };
  }

  const dryRun = await dryRunContentTransform(pageAnalysis.pdfBytes, strategy, pageAnalysis, userIntent);
  if (!dryRun.clean) {
    return {
      level: 'MANUAL_REVIEW',
      reasons: ['Dry-run (реальний виклик runPreflight() на трансформованій копії) виявив, що після масштабування+доповнення об’єкт(и) порушують margin/LEM — автоматична стратегія не пропонується.'],
    };
  }

  return {
    level: 'USER_CONFIRMATION',
    reasons: [
      `Рівномірне зменшення (коефіцієнт ${strategy.params.scaleFactor.toFixed(4)}) з доповненням ${(
        Math.max(strategy.params.padWidthTotalPt, strategy.params.padHeightTotalPt) / 72
      ).toFixed(3)}in по меншій осі.`,
      'Dry-run підтвердив: після трансформації жоден об’єкт не порушує margin/LEM.',
      dpiRisk.reason,
    ],
  };
}

function describe() {
  return {
    guarantees: [
      'Рівномірне масштабування (однаковий коефіцієнт по X та Y) — пропорції контенту не спотворюються, без non-uniform stretch.',
      'Після масштабування решта простору по короткій осі заповнюється порожнім полем (доповненням), а не кадруванням.',
      'Анотації/посилання трансформуються тим самим коефіцієнтом і зсувом, що й контент.',
      'Перед застосуванням пройдено dry-run через реальний runPreflight(); після застосування — обов’язкова повторна перевірка.',
    ],
    preconditions: [
      'Сторінка не повернута (/Rotate=0) і MediaBox має нульове походження.',
      'Немає анотацій зі складною геометрією (QuadPoints/Vertices/InkList).',
      'Прогнозований ефективний DPI растрових зображень лишається безпечним.',
    ],
  };
}

function buildTransform(strategy) {
  return {
    kind: 'CONTENT_STREAM_SCALE_PLUS_TRANSLATE',
    sx: strategy.params.scaleFactor,
    sy: strategy.params.scaleFactor,
    dx: strategy.params.dx,
    dy: strategy.params.dy,
    targetWidthPt: strategy.params.targetWidthPt,
    targetHeightPt: strategy.params.targetHeightPt,
  };
}

module.exports = { type: TYPE, contentPreserving: CONTENT_PRESERVING, detect, classify, describe, buildTransform };
