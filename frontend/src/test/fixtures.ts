/**
 * Test-only builders of engine-shaped results. These exercise how the UI
 * RENDERS and ROUTES results; they are never used by the product, and no
 * compliance is computed here.
 */
import type {
  AutofixPlan,
  BBoxPt,
  GeometryPage,
  InspectionResult,
  Verdict,
  VerifyAutofixResult,
  Violation,
} from '../engine/types';

export const bbox = (minX: number, minY: number, maxX: number, maxY: number): BBoxPt => ({ minX, minY, maxX, maxY });

function geometryPage(pageIndex: number, status: GeometryPage['status'] = 'complete'): GeometryPage {
  return {
    pageIndex,
    status,
    confidence: 'high',
    trimBox: bbox(0, 0, 432, 648),
    bleedBox: { minX: null, minY: 0, maxX: null, maxY: 648 },
    safeZone: { minX: 27, minY: 18, maxX: 405, maxY: 630 },
    allowedSides: { top: true, bottom: true, left: true, right: true },
    diagnostics: [],
  };
}

export function inspection(overrides: Partial<InspectionResult> & { verdict: Verdict }): InspectionResult {
  const violations = overrides.violations ?? [];
  const manualReview = overrides.categories?.margins.manualReview ?? [];
  return {
    document: { pageCount: 30, trimWidthIn: 6, trimHeightIn: 9, pageSizeConsistent: true },
    geometry: { status: 'complete', confidence: 'high', pages: [geometryPage(0)] },
    categories: {
      margins: {
        status: overrides.verdict === 'READY' ? 'ready' : overrides.verdict === 'NEEDS_ATTENTION' ? 'needs_attention' : 'manual_review',
        violations,
        manualReview,
        diagnostics: [],
      },
    },
    violations,
    autofixPlans: [],
    ...overrides,
  };
}

export const violation = (over: Partial<Violation> = {}): Violation => ({
  type: 'path',
  violation: 'LEM',
  side: 'top',
  amountPt: 4,
  rawBBoxPt: bbox(100, 300, 200, 634),
  visibleBBoxPt: bbox(100, 300, 200, 634),
  severity: 'warning',
  pageIndex: 2,
  ...over,
});

export const plan = (over: Partial<AutofixPlan> = {}): AutofixPlan => ({
  pageIndex: 2,
  type: 'path',
  rawBBoxPt: bbox(100, 300, 200, 634),
  visibleBBoxPt: bbox(100, 300, 200, 634),
  shift: { dx: 0, dy: -4 },
  fixedBBoxPt: bbox(100, 296, 200, 630),
  applyable: true,
  ...over,
});

export const READY = inspection({
  verdict: 'READY',
  geometry: { status: 'partial', confidence: 'high', pages: [geometryPage(0, 'partial')] },
});

export const NEEDS_ATTENTION = inspection({
  verdict: 'NEEDS_ATTENTION',
  violations: [violation(), violation({ pageIndex: 2, side: 'left', amountPt: 10, severity: 'error', type: 'text' })],
  autofixPlans: [],
});

export const WITH_PLAN = inspection({ verdict: 'NEEDS_ATTENTION', violations: [violation()], autofixPlans: [plan()] });

export const MANUAL = inspection({
  verdict: 'MANUAL_REVIEW_REQUIRED',
  categories: {
    margins: {
      status: 'manual_review',
      violations: [],
      manualReview: [{ pageIndex: 4, reason: 'TEXT_LEM_VIOLATION', sides: ['right'], maxAmountPt: 12 }],
      diagnostics: [],
    },
  },
});

export const AMBIGUOUS = inspection({
  verdict: 'MANUAL_REVIEW_REQUIRED',
  categories: {
    margins: {
      status: 'manual_review',
      violations: [],
      manualReview: [
        {
          pageIndex: 0,
          reason: 'LEM_ORIENTATION_AMBIGUOUS',
          sides: ['left'],
          maxAmountPt: 7,
          type: 'path',
          rawBBoxPt: bbox(20, 200, 40, 300),
          visibleBBoxPt: bbox(20, 200, 40, 300),
          orientation: { ltr: 'violation', rtl: 'safe' },
        },
      ],
      diagnostics: [],
    },
  },
});

export function verifyResult(over: Partial<VerifyAutofixResult> & Pick<VerifyAutofixResult, 'before'>): VerifyAutofixResult {
  return {
    after: null,
    outputBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    applied: [],
    skipped: [],
    verification: 'VERIFIED',
    reasons: [],
    ...over,
  };
}
