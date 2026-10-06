/**
 * Preflight Web Worker -- the ONLY place in the frontend that imports the
 * frozen Phase 1 engine (lib/orchestrator.js). Runs runPreflight() and
 * verifyAutofix() off the main thread so a large PDF never blocks the UI.
 *
 * Autofix in the browser: verifyAutofix() -> lib/pdfAutofixWriter.js needs
 * Node's `Buffer` and `zlib`. Rather than touching the frozen engine, the
 * worker provides them: `bufferPolyfill` (the `buffer` package) and a
 * vite alias of `zlib` -> `zlibShim.ts` (fflate's zlib-format deflate).
 * The engine's own logic -- plan, byte patch, AFTER preflight, verification
 * contract -- runs unmodified.
 */

import './bufferPolyfill';
import { configurePdfjs } from './pdfjsSetup';
import { buildEngineOptions } from './expandRequest';
import { runPreflight, verifyAutofix } from '../../../lib/orchestrator';
import { assessPageGeometry, normalizePageGeometry } from '../../../lib/pageGeometry';
import type { InspectionResult, NormalizationResult, PageGeometryAssessment, PreflightOptions, VerifyAutofixResult } from './types';

export interface PreflightWorkerRequest {
  type: 'runPreflight' | 'verifyAutofix' | 'assessPageGeometry' | 'normalizePageGeometry';
  requestId: number;
  pdfBytes: ArrayBuffer;
  options: PreflightOptions;
}

export type PreflightWorkerResponse =
  | { type: 'success'; requestId: number; result: InspectionResult | VerifyAutofixResult | PageGeometryAssessment | NormalizationResult }
  | { type: 'error'; requestId: number; message: string };

// The engine is untyped JS; src/engine/types.ts is the hand-derived
// contract, so results are cast through `unknown` explicitly.
self.onmessage = async (event: MessageEvent<PreflightWorkerRequest>) => {
  const msg = event.data;
  const opts = buildEngineOptions(msg.options) as never;
  try {
    await configurePdfjs();
    const bytes = new Uint8Array(msg.pdfBytes);
    if (msg.type === 'runPreflight') {
      const result = (await runPreflight(bytes, opts)) as unknown as InspectionResult;
      self.postMessage({ type: 'success', requestId: msg.requestId, result } satisfies PreflightWorkerResponse);
    } else if (msg.type === 'assessPageGeometry') {
      const result = (await assessPageGeometry(bytes, msg.options.userIntent)) as unknown as PageGeometryAssessment;
      self.postMessage({ type: 'success', requestId: msg.requestId, result } satisfies PreflightWorkerResponse);
    } else if (msg.type === 'normalizePageGeometry') {
      const result = (await normalizePageGeometry(bytes, opts)) as unknown as NormalizationResult;
      const out = result.outputBytes;
      const transfer = out.buffer instanceof ArrayBuffer ? [out.buffer] : [];
      self.postMessage({ type: 'success', requestId: msg.requestId, result } satisfies PreflightWorkerResponse, { transfer });
    } else {
      const result = (await verifyAutofix(bytes, opts)) as unknown as VerifyAutofixResult;
      // outputBytes' buffer is transferred, not copied.
      const out = result.outputBytes;
      const transfer = out.buffer instanceof ArrayBuffer ? [out.buffer] : [];
      self.postMessage({ type: 'success', requestId: msg.requestId, result } satisfies PreflightWorkerResponse, { transfer });
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      requestId: msg.requestId,
      message: err instanceof Error ? (err.stack ?? err.message) : String(err),
    } satisfies PreflightWorkerResponse);
  }
};
