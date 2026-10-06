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
  | 'HORIZONTAL_GEOMETRY_UNRESOLVED';

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
  reason: 'BLEED_VIOLATION' | 'TEXT_LEM_VIOLATION' | 'LEM_VIOLATION_OVER_AUTOFIX_THRESHOLD' | 'HORIZONTAL_GEOMETRY_UNRESOLVED';
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
export interface InspectionResult {
  document: {
    pageCount: number;
    trimWidthIn: number;
    trimHeightIn: number;
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
  verdict: Verdict;
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

export interface PageContext {
  pageCount?: number;
  /** Required alongside readingDirection to reach 'exact' horizontal
   * resolution for THIS page (odd/even parity) -- see lib/zones.js. */
  pageNumber?: number;
}

export interface PreflightOptions {
  userIntent: UserIntent;
  pageContext?: PageContext;
}

// ---------------------------------------------------------------------
// Smart Fix (lib/smartfix/*.js) -- hand-derived the same way as the rest
// of this file: these mirror the REAL return shapes of planRepair()/
// applyRepair() (lib/smartfix/smartFixEngine.js), buildPreview()
// (lib/smartfix/repairPreview.js), checkHardGate() (lib/smartfix/
// hardGate.js) and geometryProblems.js/repairPlanner.js. Do not duplicate
// KDP policy or Smart Fix's safety/risk classification logic anywhere on
// the frontend -- these types exist so the UI can DISPLAY what Smart Fix
// already decided, never re-decide it.
// ---------------------------------------------------------------------

export type SmartFixDocumentStatus = 'DO_NOT_TOUCH' | 'ANALYZED' | 'APPLIED';

export interface SmartFixHardGateResult {
  blocked: boolean;
  /** e.g. 'ENCRYPTED', 'DIGITALLY_SIGNED', 'DOCUMENT_UNREADABLE: ...' */
  reasons: string[];
}

/** geometryProblems.js's PageGeometryProblem. */
export type SmartFixProblemKind =
  | 'NON_ZERO_ROTATION'
  | 'NON_ZERO_ORIGIN'
  | 'BOX_CONFLICT'
  | 'MISSING_TRIM_BOX'
  | 'TOO_SMALL'
  | 'TOO_LARGE'
  | 'WRONG_ASPECT';

export interface SmartFixProblem {
  pageIndex: number;
  kind: SmartFixProblemKind;
  /** Plain-sentence (Ukrainian) detail from the engine -- not displayed
   * verbatim by the UI (too jargon-heavy); used only as a fallback / for
   * developer-facing surfaces. The UI builds its own plain-language copy
   * from `kind` + `measured` + `expected` instead. */
  detail: string;
  measured: { widthIn: number; heightIn: number };
  expected: { widthIn: number | null; heightIn: number | null };
}

export type SmartFixRiskLevel = 'SAFE_AUTOFIX' | 'USER_CONFIRMATION' | 'MANUAL_REVIEW';

export interface SmartFixRisk {
  level: SmartFixRiskLevel;
  reasons: string[];
}

export type SmartFixStrategyType = 'BOX_NORMALIZATION' | 'PADDING' | 'PROPORTIONAL_SCALE' | 'SCALE_PLUS_PADDING';

export interface SmartFixStrategy {
  type: SmartFixStrategyType;
  /** Strategy-specific numeric params (targetWidthPt, scaleFactor, dx,
   * dy, padWidthTotalPt, ...). Never pattern-matched by the UI beyond
   * what repairPreview.js already surfaces via SmartFixPreviewEntry --
   * the UI reads targetWidthPt/targetHeightPt only to render inches. */
  params: Record<string, unknown>;
  risk: SmartFixRisk;
  /** Plain-language (Ukrainian) sentences the engine itself already wrote
   * -- e.g. "Жоден існуючий піксель чи вектор не видаляється, не
   * обрізається і не масштабується." Surfaced to the user verbatim as
   * the "what this guarantees" list; never rewritten or re-derived. */
  guarantees: string[];
  preconditions: string[];
  contentPreserving: boolean;
}

export interface SmartFixRepairPlan {
  pageIndex: number;
  problem: SmartFixProblem | null;
  chosenStrategy: SmartFixStrategy | null;
  alternativeStrategies: SmartFixStrategy[];
  /** Plain-sentence (Ukrainian) explanation from the engine -- same
   * caveat as SmartFixProblem.detail: a developer-facing fallback, not
   * what the UI renders as its primary copy. */
  explanation: string;
}

export interface SmartFixDocumentSummary {
  pageCount: number;
  pageSizeConsistent: boolean;
}

/** repairPreview.js's buildPreview() entry -- the Before/After data the
 * UI shows ahead of any Apply action. riskLevel here also includes
 * 'NONE' for a page with no problem and nothing to propose. */
export interface SmartFixPreviewEntry {
  pageIndex: number;
  before: { widthIn: number; heightIn: number; problem: SmartFixProblemKind | null };
  after: { widthIn: number; heightIn: number } | null;
  strategyType: SmartFixStrategyType | null;
  riskLevel: SmartFixRiskLevel | 'NONE';
  guarantees: string[];
  explanation: string;
}

export interface SmartFixPlanResult {
  documentStatus: 'DO_NOT_TOUCH' | 'ANALYZED';
  hardGate: SmartFixHardGateResult;
  document?: SmartFixDocumentSummary;
  plans: SmartFixRepairPlan[];
  preview?: SmartFixPreviewEntry[];
  explanation: string;
}

export interface SmartFixSkippedPage {
  pageIndex: number;
  /** 'MANUAL_REVIEW' | `NOT_CONFIRMED_${SmartFixRiskLevel}` */
  reason: string;
}

export interface SmartFixInvariants {
  pageCountPreserved: boolean;
  annotationCountPreserved: boolean;
}

export interface SmartFixApplyResult {
  documentStatus: SmartFixDocumentStatus;
  before: InspectionResult | null;
  after: InspectionResult | null;
  outputBytes: Uint8Array;
  appliedPageIndexes: number[];
  skipped: SmartFixSkippedPage[];
  invariants: SmartFixInvariants | null;
  /** The single authoritative gate: only true means re-preflight found
   * zero violations/manual-review on every page Smart Fix touched. The
   * UI must never show a VERIFIED state or a Download button unless this
   * is exactly `true`. */
  verified: boolean;
  reasons: string[];
  notes?: string[];
}

export type SmartFixProgressStage = 'APPLYING' | 'CHECKING';

export interface SmartFixApplyOptions {
  confirmedPageIndexes?: number[];
}
