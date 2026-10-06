import type { InspectionResult, NormalizationResult, PageGeometryAssessment, PreflightOptions, VerifyAutofixResult } from './types';

/** What the workspace needs from the engine. The real implementation is the
 * Web Worker client; tests inject their own. */
export interface EngineApi {
  /** `pdfBytes` is never mutated or detached. */
  runPreflight(pdfBytes: Uint8Array, options: PreflightOptions): Promise<InspectionResult>;
  /** The engine's authoritative check -> fix -> re-check loop. Only call
   * after explicit user confirmation when applyable plans exist. */
  verifyAutofix(pdfBytes: Uint8Array, options: PreflightOptions): Promise<VerifyAutofixResult>;
  /** Analysis only (never writes): page boxes vs the user's selection. */
  assessPageGeometry(pdfBytes: Uint8Array, options: PreflightOptions): Promise<PageGeometryAssessment>;
  /** Writes ONLY page boxes (after explicit user approval), verifies the
   * result byte-wise, then runs the real preflight on the output. */
  normalizePageGeometry(pdfBytes: Uint8Array, options: PreflightOptions): Promise<NormalizationResult>;
  dispose(): void;
}
