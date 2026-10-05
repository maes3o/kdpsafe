import type { InspectionResult, PreflightOptions, VerifyAutofixResult } from './types';

/** What the workspace needs from the engine. The real implementation is the
 * Web Worker client; tests inject their own. */
export interface EngineApi {
  /** `pdfBytes` is never mutated or detached. */
  runPreflight(pdfBytes: Uint8Array, options: PreflightOptions): Promise<InspectionResult>;
  /** The engine's authoritative check -> fix -> re-check loop. Only call
   * after explicit user confirmation when applyable plans exist. */
  verifyAutofix(pdfBytes: Uint8Array, options: PreflightOptions): Promise<VerifyAutofixResult>;
  dispose(): void;
}
