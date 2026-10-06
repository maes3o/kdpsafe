'use strict';

/**
 * PROPORTIONAL_SCALE — uniform shrink that lands EXACTLY on the target on
 * BOTH axes with zero padding needed (i.e. the page's aspect ratio already
 * matches the target's). The degenerate, zero-padding case of
 * scaleMath.js's general formula — see scalePlusPadding.js for the general
 * case and that module's header for why Phase 2 never reaches an enlarge
 * (scaleFactor > 1) through this strategy's own detect().
 *
 * Never SAFE_AUTOFIX: scaling always changes every object's on-page size,
 * which is a materially different kind of change from BOX_NORMALIZATION's
 * zero-content-risk box-dict edit or PADDING's purely-additive canvas
 * growth — "safety over coverage" means a human confirms this every time,
 * never silently.
 */

const { TOLERANCE_PT } = require('../../margin');
const { computeScalePlusPadding } = require('../scaleMath');
const { dryRunContentTransform } = require('../dryRun');
const { assessUpscaleDpiRisk } = require('../dpiEstimator');

const TYPE = 'PROPORTIONAL_SCALE';
const CONTENT_PRESERVING = true;

const SCALE_TARGETABLE_KINDS = new Set(['TOO_LARGE', 'WRONG_ASPECT']);

function detect(problem, pageAnalysis) {
  if (!problem || !SCALE_TARGETABLE_KINDS.has(problem.kind)) return null;
  if (!pageAnalysis.target) return null;

  const measuredWidthPt = pageAnalysis.measured.widthIn * 72;
  const measuredHeightPt = pageAnalysis.measured.heightIn * 72;
  const { scaleFactor, padWidthTotalPt, padHeightTotalPt } = computeScalePlusPadding(
    measuredWidthPt,
    measuredHeightPt,
    pageAnalysis.target.widthPt,
    pageAnalysis.target.heightPt
  );

  // Only this strategy's own narrow slice: both pads are ~0 (aspect ratio
  // already matches target). scalePlusPadding.js handles every other
  // case for the same two problem kinds.
  if (Math.abs(padWidthTotalPt) > TOLERANCE_PT || Math.abs(padHeightTotalPt) > TOLERANCE_PT) return null;

  return {
    type: TYPE,
    params: {
      scaleFactor,
      dx: 0,
      dy: 0,
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
      reasons: ['Dry-run (реальний виклик runPreflight() на трансформованій копії) виявив, що після масштабування об’єкт(и) порушують margin/LEM — автоматична стратегія не пропонується.'],
    };
  }

  return {
    level: 'USER_CONFIRMATION',
    reasons: [
      `Рівномірне зменшення (коефіцієнт ${strategy.params.scaleFactor.toFixed(4)}) без доповнення — ширина й висота вже точно відповідають цільовому розміру після масштабування.`,
      'Dry-run підтвердив: після трансформації жоден об’єкт не порушує margin/LEM.',
      dpiRisk.reason,
    ],
  };
}

function describe() {
  return {
    guarantees: [
      'Рівномірне масштабування (однаковий коефіцієнт по X та Y) — пропорції контенту не спотворюються.',
      'Жодного кадрування (crop) — весь контент залишається видимим.',
      'Анотації/посилання трансформуються тим самим коефіцієнтом, що й контент.',
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
