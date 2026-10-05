/**
 * Preflight Web Worker -- the ONLY place in the frontend that imports the
 * frozen Phase 1 engine (lib/orchestrator.js). Runs runPreflight() off the
 * main thread so a large/complex PDF never blocks the UI.
 *
 * SCOPE OF THIS CHECKPOINT (FRONTEND-01): only the READ-ONLY
 * runPreflight() path is wired here. verifyAutofix()'s "apply" branch
 * (lib/orchestrator.js -> lib/pdfAutofixWriter.js -> lib/geometryRewriter.js)
 * depends on Node's `Buffer`/`zlib`.
 *
 * Empirically confirmed via `vite build`: this does NOT fail the build.
 * Vite/rolldown externalizes `zlib` (a warning, not an error) because
 * lib/orchestrator.js's `require('./pdfAutofixWriter')` inside
 * verifyAutofix() is lazy, and esbuild/rolldown still resolves it eagerly
 * at bundle time even though this worker never calls verifyAutofix(). The
 * externalized import is harmless for THIS worker because that code path
 * is never reached at runtime here. It becomes a real, genuine blocker
 * only once the frontend actually wires up the autofix-APPLY UX and tries
 * to call verifyAutofix()'s applying branch in the browser -- `zlib` has
 * no browser polyfill loaded, so that call would throw at runtime. That
 * is deliberately NOT worked around in this checkpoint; it is a decision
 * for whichever future checkpoint builds the autofix-apply flow.
 */

import { runPreflight } from '../../../lib/orchestrator';
import type { InspectionResult, PreflightOptions } from './types';

export interface PreflightRequest {
  type: 'runPreflight';
  requestId: number;
  pdfBytes: ArrayBuffer;
  options: PreflightOptions;
}

export type PreflightWorkerRequest = PreflightRequest;

export interface PreflightSuccessResponse {
  type: 'runPreflight:success';
  requestId: number;
  result: InspectionResult;
}

export interface PreflightErrorResponse {
  type: 'runPreflight:error';
  requestId: number;
  message: string;
}

export type PreflightWorkerResponse = PreflightSuccessResponse | PreflightErrorResponse;

self.onmessage = async (event: MessageEvent<PreflightWorkerRequest>) => {
  const msg = event.data;

  if (msg.type === 'runPreflight') {
    try {
      // The engine is plain untyped JS (allowJs, no .d.ts) -- TS infers a
      // structural shape from the actual code that's close but not
      // identical to our hand-derived InspectionResult (e.g. literal
      // `string` vs our narrower unions), so a direct assertion is
      // rejected as insufficiently overlapping. `unknown` is the correct,
      // explicit way to say "trust the hand-derived contract here", not a
      // type-safety hole specific to this call.
      const result = (await runPreflight(new Uint8Array(msg.pdfBytes), {
        userIntent: msg.options.userIntent,
        pageContext: msg.options.pageContext,
      })) as unknown as InspectionResult;
      const response: PreflightSuccessResponse = { type: 'runPreflight:success', requestId: msg.requestId, result };
      self.postMessage(response);
    } catch (err) {
      const response: PreflightErrorResponse = {
        type: 'runPreflight:error',
        requestId: msg.requestId,
        message: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    }
  }
};
