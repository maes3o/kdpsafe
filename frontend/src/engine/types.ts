/**
 * TypeScript contract for the frozen Phase 1 engine (lib/orchestrator.js,
 * at commit 3d4e183 / CHECKPOINT 5F). Every shape here is transcribed
 * directly from what runPreflight()/verifyAutofix() ACTUALLY return and
 * from the real push sites in lib/orchestrator.js, lib/margin.js and
 * lib/marginPolicy.js -- nothing here is invented or guessed ahead of the
 * engine. If the engine's real shape ever changes, this file must be
 * re-derived from the code, not patched to make a UI feature fit.
 *
 * This is the single source of truth for engine-result typing on the
 * frontend. Do not duplicate KDP policy or compliance logic anywhere
 * else -- `verdict` (InspectionResult) and `verification`
 * (VerifyAutofixResult) are authoritative; the UI only ever displays them.
 */

// ---------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------

/** A fully-resolved axis-aligned box in PDF points. trimBoxPt is always
 * either this (all four fields real numbers) or absent entirely -- trim
 * never partially resolves. */
export interface BBoxPt {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** safeZoneBBoxPt / bleedBoxPt's shape: the VERTICAL extent (minY/maxY) is
 * always deterministic once the box exists at all, but the HORIZONTAL
 * extent (minX/maxX) can independently stay `null` -- orientation
 * ('exact') or page-parity information was never given, so the engine
 * explicitly refuses to guess which physical edge is the gutter. A `null`
 * on minX/maxX here is a real "unknown", never a 0. See
 * lib/orchestrator.js's resolveAllowedSides() / isResolvedNumber(). */
export interface PartialHorizontalBBoxPt {
  minX: number | null;
  minY: number;
  maxX: number | null;
  maxY: number;
}

export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface AllowedSides {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
}

export type GeometryStatus = 'complete' | 'partial' | 'unavailable';
export type ComplianceConfidence = 'high' | 'insufficient' | 'conflict';

/**
 * `status !== 'complete'` (i.e. 'partial') is NOT a failure state and
 * must never be displayed as one -- a 'partial'/conservative-orientation
 * page can still, correctly, carry `verdict === 'READY'`. Only
 * `allowedSides` (and, downstream, `verdict`) decide what the UI should
 * actually warn about.
 */
export interface GeometryPage {
  pageIndex: number;
  status: GeometryStatus;
  confidence: ComplianceConfidence;
  trimBox: BBoxPt | null;
  bleedBox: PartialHorizontalBBoxPt | null;
  safeZone: PartialHorizontalBBoxPt | null;
  allowedSides: AllowedSides;
  /** Raw per-page diagnostics -- no `pageIndex` field (the page it's on is
   * already implicit from this array's position). */
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  code: string;
  message: string;
}

/** Same diagnostic shape, but rolled up to `categories.margins.diagnostics`
 * with an explicit `pageIndex` added (lib/orchestrator.js's
 * rollUpMarginsCategory()). */
export interface DiagnosticWithPage extends Diagnostic {
  pageIndex: number;
}

// ---------------------------------------------------------------------
// Violations / manual review / autofix plans
// ---------------------------------------------------------------------

export type ObjectType = 'text' | 'image' | 'path';
export type ViolationKind = 'LEM' | 'BLEED';
export type Severity = 'warning' | 'error';

/** A CONFIRMED violation -- lib/margin.js's classifyViolations() output,
 * after CHECKPOINT 5C's ambiguity split has already removed any
 * orientation-ambiguous LEM entries into manualReview[] instead. Every
 * entry here is definite, never provisional. */
export interface Violation {
  type: ObjectType;
  violation: ViolationKind;
  side: Side;
  amountPt: number;
  rawBBoxPt: BBoxPt;
  visibleBBoxPt: BBoxPt;
  severity: Severity;
  pageIndex: number;
}

export type ManualReviewReason =
  | 'LEM_ORIENTATION_AMBIGUOUS'
  | 'BLEED_VIOLATION'
  | 'TEXT_LEM_VIOLATION'
  | 'LEM_VIOLATION_OVER_AUTOFIX_THRESHOLD'
  | 'HORIZONTAL_GEOMETRY_UNRESOLVED'
  | 'PAGE_ROTATION_UNSUPPORTED';

interface ManualReviewEntryBase {
  pageIndex: number;
  reason: ManualReviewReason;
  sides: Side[];
  maxAmountPt: number | null;
}

/** The ONLY manual-review reason the UI can actually resolve with a piece
 * of input (readingDirection) rather than just reporting. Carries which
 * named orientation hypothesis passes/fails so the UI never has to
 * recompute anything -- it only ever asks the user ltr-or-rtl and
 * resubmits userIntent.readingDirection for a fresh runPreflight(). */
export interface AmbiguousOrientationEntry extends ManualReviewEntryBase {
  reason: 'LEM_ORIENTATION_AMBIGUOUS';
  type: ObjectType;
  rawBBoxPt: BBoxPt;
  visibleBBoxPt: BBoxPt;
  orientation: { ltr: 'violation' | 'safe'; rtl: 'violation' | 'safe' };
}

/** Everything else: reported, not resolvable by any UI input -- the user
 * must fix the source file or accept manual review. */
export interface OtherManualReviewEntry extends ManualReviewEntryBase {
  reason:
    | 'BLEED_VIOLATION'
    | 'TEXT_LEM_VIOLATION'
    | 'LEM_VIOLATION_OVER_AUTOFIX_THRESHOLD'
    | 'HORIZONTAL_GEOMETRY_UNRESOLVED'
    | 'PAGE_ROTATION_UNSUPPORTED';
}

export type ManualReviewEntry = AmbiguousOrientationEntry | OtherManualReviewEntry;

/**
 * A PLAN, not evidence of a fix. `autofixPlans[]` describes what the
 * engine COULD do if asked -- nothing in the document has changed yet.
 * `applyable: false` means a safe plan exists but this repo's v1
 * byte-level rewriter cannot physically perform it (see
 * `applyableReason`); such a plan can be shown in an "Autofix preview"
 * but must never offer an "Apply" action.
 */
export interface AutofixPlan {
  pageIndex: number;
  type: ObjectType;
  rawBBoxPt: BBoxPt;
  visibleBBoxPt: BBoxPt;
  shift: { dx: number; dy: number };
  fixedBBoxPt: BBoxPt;
  applyable: boolean;
  applyableReason?: string;
}

// ---------------------------------------------------------------------
// Category / verdict
// ---------------------------------------------------------------------

export type MarginsStatus = 'manual_review' | 'needs_attention' | 'ready';
export type Verdict = 'READY' | 'NEEDS_ATTENTION' | 'MANUAL_REVIEW_REQUIRED';

export interface MarginsCategory {
  status: MarginsStatus;
  violations: Violation[];
  manualReview: ManualReviewEntry[];
  diagnostics: DiagnosticWithPage[];
}

/**
 * runPreflight()'s full return shape. `verdict` is authoritative -- it is
 * already the worst-of rollup across every category (today, only
 * `margins`; Phase 2 categories are deliberately absent, not faked as
 * passing). The UI must never recompute a verdict from violations[]
 * itself.
 */
// ---------------------------------------------------------------------
// Phase 2A: read-only PDF integrity checks (lib/integrity.js)
// ---------------------------------------------------------------------

export type IntegrityStatus = 'PASS' | 'FAIL' | 'WARNING' | 'UNKNOWN';
/** BLOCKING = deterministic requirement violated (-> NEEDS_ATTENTION);
 * MANUAL_REVIEW = detected / not determinable (-> MANUAL_REVIEW_REQUIRED). */
export type IntegrityImpact = 'NONE' | 'BLOCKING' | 'MANUAL_REVIEW';

export type IntegrityCheckId =
  | 'SECURITY_ENCRYPTION'
  | 'BOOKMARKS'
  | 'ANNOTATIONS_COMMENTS'
  | 'FILE_SIZE'
  | 'FONTS_EMBEDDED'
  | 'DIGITAL_SIGNATURES'
  | 'FORMS_WIDGETS'
  | 'LINK_ANNOTATIONS'
  | 'IMAGE_DPI'
  | 'SPREADS'
  | 'ORIENTATION'
  | 'INTEGRITY_INSPECTION';

export interface IntegrityFinding {
  id: IntegrityCheckId;
  category: string;
  status: IntegrityStatus;
  impact: IntegrityImpact;
  /** Machine reason (e.g. ENCRYPTED, NOT_EMBEDDED, CHECK_FAILED); the UI localizes by id + code. */
  code: string;
  message: string;
  details: Record<string, unknown>;
  pages?: number[];
  objects?: string[];
  evidence?: Record<string, unknown>;
  diagnostics?: { code: string; message: string }[];
}

export interface IntegrityResult {
  version: number;
  /** Exactly one finding per check, in a fixed order. */
  checks: IntegrityFinding[];
  summary: { total: number; passed: number; blocking: number; warning: number; unknown: number; manualReview: number };
  impact: IntegrityImpact;
}

export interface InspectionResult {
  document: {
    pageCount: number;
    /** PAGE size (CropBox clipped to MediaBox, rotation applied) of page 1.
     * NOT a trim size: the trim is only known from an explicit /TrimBox or
     * from the user's selection (see PageGeometryAssessment). */
    pageWidthIn: number;
    pageHeightIn: number;
    pageSizeConsistent: boolean;
  };
  geometry: {
    status: GeometryStatus;
    confidence: ComplianceConfidence;
    pages: GeometryPage[];
  };
  categories: {
    margins: MarginsCategory;
  };
  /** Same array as categories.margins.violations -- exposed at the top
   * level too by the engine itself; read either, they are identical. */
  violations: Violation[];
  autofixPlans: AutofixPlan[];
  /** The ONE authoritative verdict: the geometry verdict rolled up with the
   * Phase 2A integrity findings (blockers -> NEEDS_ATTENTION, manual/unknown
   * -> MANUAL_REVIEW_REQUIRED). Never recompute it in the UI. */
  verdict: Verdict;
  /** The geometry-only verdict (what `verdict` was before Phase 2A). */
  geometryVerdict: Verdict;
  integrity: IntegrityResult;
}

// ---------------------------------------------------------------------
// verifyAutofix()
// ---------------------------------------------------------------------

export interface AppliedFix {
  plan: AutofixPlan;
  patch: { before: { x: number; y: number }; after: { x: number; y: number }; dx: number; dy: number };
}

/** Known skip reasons from lib/pdfAutofixWriter.js / lib/geometryRewriter.js.
 * Not exhaustive by TypeScript's enforcement (kept as `string` on
 * SkippedFix itself) -- the engine may report a reason not in this list
 * without breaking the frontend; this union exists for UI copy lookup
 * with a documented fallback for anything unrecognized. */
export type KnownSkipReason =
  | 'page_not_found'
  | 'no_content_stream'
  | 'multi_stream_contents_unsupported'
  | 'ambiguous_rect_match'
  | 'rect_not_found';

export interface SkippedFix {
  plan: AutofixPlan;
  reason: string;
}

export type VerificationResult = 'VERIFIED' | 'MANUAL_REVIEW_REQUIRED';

/** Known reason codes from lib/orchestrator.js's evaluateVerification()/
 * verifyAutofix(). Same documented-but-not-enforced relationship to the
 * `reasons: string[]` field as KnownSkipReason above. */
export type KnownVerificationReason =
  | 'NO_APPLICABLE_AUTOFIX'
  | 'AUTOFIX_NOT_SAFELY_APPLICABLE'
  | 'GEOMETRY_UNRESOLVED'
  | 'ISSUE_REMAINS'
  | 'NEW_VIOLATIONS_AFTER_FIX'
  | 'MANUAL_REVIEW_REMAINS';

/**
 * verifyAutofix()'s full return shape.
 *
 * CHECKPOINT 5F contract (explicit, intentional -- see
 * lib/orchestrator.js): when `before.verdict === 'READY'` and nothing was
 * applicable to autofix, `after` is `null` and `verification` is
 * `'VERIFIED'` -- this means "already verified, no mutation was
 * necessary", NOT "a second preflight confirmed it". The UI must treat
 * this as a fully valid, final VERIFIED state (see state #8 "Verified
 * result" in the product spec) and must not treat `after === null` as
 * missing data or an error in this case.
 */
export interface VerifyAutofixResult {
  before: InspectionResult;
  after: InspectionResult | null;
  outputBytes: Uint8Array;
  applied: AppliedFix[];
  skipped: SkippedFix[];
  verification: VerificationResult;
  reasons: string[];
}

// ---------------------------------------------------------------------
// Engine call inputs (opts passed to runPreflight()/verifyAutofix())
// ---------------------------------------------------------------------

export interface UserIntent {
  trimSize: { widthIn: number; heightIn: number };
  bleed: boolean;
  /** Only when the user has answered the LEM_ORIENTATION_AMBIGUOUS prompt
   * (or already knows it) -- omitted, the engine resolves safe zones
   * conservatively (CHECKPOINT 5A/5C) rather than guessing. */
  readingDirection?: 'ltr' | 'rtl';
}

/** The only anchor available to the product: the page keeps its existing origin
 * (lower-left corner) and space is added on the right and at the top. A centered
 * variant exists in the engine for research only and is never exposed (it needs a
 * negative MediaBox origin, which is unsupported). */
export type ExpandAnchor = 'keep-origin';

/** Everything the frontend may ask of the engine. There is deliberately NO page
 * count / page context: the engine derives it from the PDF itself, and the worker
 * never forwards anything beyond these fields. */
export interface PreflightOptions {
  userIntent: UserIntent;
  /** normalizePageGeometry only: run the "Expand page" operation instead of
   * the Tier 1/2 plan. Both fields are required by the engine; it fails
   * closed without an explicit anchor and `confirmed: true`. */
  expandPage?: { anchor: ExpandAnchor | null; confirmed: boolean };
}

// ---------------------------------------------------------------------
// Page geometry (lib/pageGeometry.js) -- page BOXES, never content
// ---------------------------------------------------------------------

export type GeometryCategory =
  | 'EXACT_TRIM_PRESENT'
  | 'EXACT_PAGE_NO_TRIM'
  | 'EXACT_PAGE_WITH_BLEED'
  | 'SIMILAR_COMPATIBLE'
  | 'DIFFERENT_SIZE'
  | 'ROTATED_UNCERTAIN'
  | 'MIXED_DOCUMENT'
  | 'CONFLICTING_BOXES'
  | 'DO_NOT_TOUCH';

/** 0 nothing to do | 1 metadata-only (add TrimBox) | 2 trim+bleed with known
 * reading direction | 3 close-but-different (manual) | 4 different size
 * (manual) | 5 do not touch (manual). */
export type GeometryTier = 0 | 1 | 2 | 3 | 4 | 5;

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageGeometryPageAssessment {
  pageIndex: number;
  pageNumber: number;
  parity: 'odd' | 'even';
  category: GeometryCategory;
  reasons: string[];
  rotationDeg: number;
  effectiveSizePt: { widthPt: number; heightPt: number };
  mediaBox: PdfRect;
  cropBox: { explicit: boolean } & PdfRect;
  trimBox: { explicit: boolean } & Partial<PdfRect>;
  bleedBox: { explicit: boolean } & Partial<PdfRect>;
}

export interface NormalizationPlan {
  kind: 'ADD_TRIM_BOX' | 'DEFINE_TRIM_BOX_FROM_BLEED';
  tier: 1 | 2;
  changes: { pageIndex: number; before: { trimBox: null; bleedBox: null }; set: { trimBox: PdfRect; bleedBox?: PdfRect } }[];
  /** Always: page metadata only. */
  guarantees: { contentStreamsUnchanged: true; scales: false; crops: false; moves: false; rotates: false };
}

/** The user-initiated "Expand page to the selected size" offer (page boxes
 * only: no scaling, cropping or content changes). Present only when some
 * page is smaller than the selected trim. */
export interface ExpandOffer {
  applicable: true;
  /** false => `reasons` explain why KDPSafe will not offer the operation. */
  eligible: boolean;
  reasons: string[];
  target: { widthPt: number; heightPt: number } | null;
  current: { widthPt: number; heightPt: number } | null;
  /** Space each anchor would add around the current page (points). */
  previews: Record<ExpandAnchor, { addedPt: { left: number; bottom: number; right: number; top: number } }> | null;
  pageCount: number;
}

/** What KDPSafe knows about the PDF's page boxes versus the user's
 * selection. Analysis only: nothing here has changed the file. */
export interface PageGeometryAssessment {
  selectedTrim: { widthIn: number; heightIn: number };
  bleed: boolean;
  readingDirection: 'ltr' | 'rtl' | null;
  pageCount: number;
  encrypted: boolean;
  signed: boolean;
  pages: PageGeometryPageAssessment[];
  category: GeometryCategory;
  tier: GeometryTier;
  /** Machine codes explaining the category (mapped to localized text in the UI). */
  reasons: string[];
  /** Effective page size of page 1, in inches (null if unreadable). */
  pageSize: { widthIn: number; heightIn: number } | null;
  trimBox: 'explicit' | 'missing' | 'mixed';
  plan: NormalizationPlan | null;
  /** Optional Expand-page offer; null when no page is smaller than the selected trim. */
  expand: ExpandOffer | null;
  loadError?: string;
}

export interface SafetyCheck {
  id: string;
  ok: boolean;
  detail?: string;
}

/** normalizePageGeometry(): `after` is the REAL preflight of the changed
 * file and is authoritative -- there is no separate "normalized = OK". */
export interface NormalizationResult {
  applied: boolean;
  assessment: PageGeometryAssessment;
  /** The changed bytes when `applied`, otherwise the unchanged input. */
  outputBytes: Uint8Array;
  safety: { ok: boolean; checks: SafetyCheck[]; failure: string | null } | null;
  before: InspectionResult | null;
  after: InspectionResult | null;
  /** Set only when an Expand-page operation was applied. */
  expand?: { anchor: ExpandAnchor; pagesChanged: number; target: { widthPt: number; heightPt: number } };
}
