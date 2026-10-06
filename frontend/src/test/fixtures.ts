/**
 * Test-only builders of engine-shaped results. These exercise how the UI
 * RENDERS and ROUTES results; they are never used by the product, and no
 * compliance is computed here.
 */
import type {
  ExpandOffer,
  NormalizationPlan,
  NormalizationResult,
  PageGeometryAssessment,
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
    document: { pageCount: 30, pageWidthIn: 6, pageHeightIn: 9, pageSizeConsistent: true },
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

// ---- page-geometry assessments (what lib/pageGeometry.js returns) ----

const pageRect = { x: 0, y: 0, width: 432, height: 648 };

export function assessment(over: Partial<PageGeometryAssessment> = {}): PageGeometryAssessment {
  return {
    selectedTrim: { widthIn: 6, heightIn: 9 },
    bleed: false,
    readingDirection: null,
    pageCount: 30,
    encrypted: false,
    signed: false,
    pages: [],
    category: 'EXACT_TRIM_PRESENT',
    tier: 0,
    reasons: [],
    pageSize: { widthIn: 6, heightIn: 9 },
    trimBox: 'explicit',
    plan: null,
    expand: null,
    ...over,
  };
}

export const addTrimBoxPlan: NormalizationPlan = {
  kind: 'ADD_TRIM_BOX',
  tier: 1,
  changes: Array.from({ length: 30 }, (_, pageIndex) => ({
    pageIndex,
    before: { trimBox: null, bleedBox: null },
    set: { trimBox: { ...pageRect } },
  })),
  guarantees: { contentStreamsUnchanged: true, scales: false, crops: false, moves: false, rotates: false },
};

export const TIER1 = assessment({ category: 'EXACT_PAGE_NO_TRIM', tier: 1, trimBox: 'missing', plan: addTrimBoxPlan });
export const TIER4 = assessment({
  category: 'DIFFERENT_SIZE',
  tier: 4,
  trimBox: 'missing',
  reasons: ['SIZE_DIFFERENT'],
  pageSize: { widthIn: 8.2677, heightIn: 11.6929 },
});
export const TIER5_SIGNED = assessment({ category: 'DO_NOT_TOUCH', tier: 5, trimBox: 'missing', signed: true, reasons: ['SIGNED'] });

/** 30 identical per-page entries, exactly like the engine reports without a TrimBox. */
export const UNRESOLVED_30 = inspection({
  verdict: 'MANUAL_REVIEW_REQUIRED',
  categories: {
    margins: {
      status: 'manual_review',
      violations: [],
      manualReview: Array.from({ length: 30 }, (_, pageIndex) => ({
        pageIndex,
        reason: 'HORIZONTAL_GEOMETRY_UNRESOLVED' as const,
        sides: ['top', 'bottom', 'left', 'right'] as ('top' | 'bottom' | 'left' | 'right')[],
        maxAmountPt: null,
      })),
      diagnostics: [],
    },
  },
});

export function normalizationResult(over: Partial<NormalizationResult> & Pick<NormalizationResult, 'after'>): NormalizationResult {
  return {
    applied: true,
    assessment: assessment({ category: 'EXACT_TRIM_PRESENT', tier: 0, trimBox: 'explicit' }),
    outputBytes: new Uint8Array([9, 9, 9, 9, 9]),
    safety: {
      ok: true,
      checks: [
        { id: 'PAGE_COUNT_UNCHANGED', ok: true },
        { id: 'CONTENT_STREAMS_BYTE_IDENTICAL', ok: true },
        { id: 'BOXES_MATCH_PLAN', ok: true },
      ],
      failure: null,
    },
    before: null,
    ...over,
  };
}

// ---- Expand page (advanced repair #1) ----


export const expandOffer = (over: Partial<ExpandOffer> = {}): ExpandOffer => ({
  applicable: true,
  eligible: true,
  reasons: [],
  target: { widthPt: 432, heightPt: 648 },
  current: { widthPt: 396, heightPt: 612 },
  previews: {
    center: { addedPt: { left: 18, bottom: 18, right: 18, top: 18 } },
    'keep-origin': { addedPt: { left: 0, bottom: 0, right: 36, top: 36 } },
  },
  pageCount: 30,
  ...over,
});

/** A smaller-than-selected page: Tier 4 (manual) plus the optional expand offer. */
export const EXPANDABLE = assessment({
  category: 'DIFFERENT_SIZE',
  tier: 4,
  trimBox: 'missing',
  reasons: ['SIZE_DIFFERENT'],
  pageSize: { widthIn: 5.5, heightIn: 8.5 },
  expand: expandOffer(),
});

export function expandApplied(anchor: 'center' | 'keep-origin', after: InspectionResult): NormalizationResult {
  return {
    applied: true,
    assessment: EXPANDABLE,
    outputBytes: new Uint8Array([7, 7, 7, 7, 7]),
    safety: {
      ok: true,
      checks: [
        { id: 'PAGE_COUNT_UNCHANGED', ok: true },
        { id: 'CONTENT_STREAMS_BYTE_IDENTICAL', ok: true },
        { id: 'RESOURCES_UNCHANGED', ok: true },
        { id: 'AFTER_PREFLIGHT_READY', ok: true },
      ],
      failure: null,
    },
    before: null,
    after,
    expand: { anchor, pagesChanged: 30, target: { widthPt: 432, heightPt: 648 } },
  };
}
