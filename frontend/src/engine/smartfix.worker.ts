/**
 * Smart Fix Web Worker -- the ONLY place in the frontend that imports
 * lib/smartfix/smartFixEngine.js, mirroring preflight.worker.ts's own
 * pattern exactly (one worker per engine entry point, runs off the main
 * thread so a large PDF never blocks the UI).
 *
 * Browser-safety note (resolved, not deferred): applyRepair() writes PDF
 * bytes via lib/smartfix/repairWriter.js, which used to depend on Node's
 * global `Buffer`. That call was switched to `TextEncoder`-produced
 * `Uint8Array` (a pure encoding-mechanics change, not a safety-model
 * change) specifically so this worker can call applyRepair() in the
 * browser. Smart Fix's own re-verification step calls runPreflight() --
 * never verifyAutofix() -- so it never touches the still-Node-only
 * lib/pdfAutofixWriter.js/lib/geometryRewriter.js pair that
 * preflight.worker.ts's header documents as deferred; that limitation is
 * unrelated to Smart Fix and remains exactly as deferred as before.
 *
 * Does not duplicate any Smart Fix safety/KDP logic here -- this file
 * only marshals requests/responses to and from the real planRepair()/
 * applyRepair().
 */

import legacyPdfWorkerUrl from '../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { planRepair, applyRepair } from '../../../lib/smartfix/smartFixEngine';
import type { SmartFixApplyOptions, SmartFixApplyResult, SmartFixPlanResult, SmartFixProgressStage, UserIntent } from './types';

// See preflight.worker.ts for the full explanation: lib/margin.js (used
// both by planRepair()'s geometry analysis and by applyRepair()'s
// mandatory runPreflight() re-check) resolves its own bare 'pdfjs-dist'
// specifier to the REPO ROOT's node_modules (it lives there), not
// frontend/node_modules -- so this import must use the same explicit
// relative path, not the bare specifier, to actually share one
// GlobalWorkerOptions instance with it.
const legacyPdfjsWorkerSrcReady = (async () => {
  const legacyPdfjsLib = await import('../../../node_modules/pdfjs-dist/legacy/build/pdf.mjs');
  legacyPdfjsLib.GlobalWorkerOptions.workerSrc = legacyPdfWorkerUrl;
})();

export interface SmartFixPlanRequest {
  type: 'planRepair';
  requestId: number;
  pdfBytes: ArrayBuffer;
  userIntent: UserIntent;
}

export interface SmartFixApplyRequest {
  type: 'applyRepair';
  requestId: number;
  pdfBytes: ArrayBuffer;
  userIntent: UserIntent;
  opts?: SmartFixApplyOptions;
}

export type SmartFixWorkerRequest = SmartFixPlanRequest | SmartFixApplyRequest;

export interface SmartFixPlanSuccessResponse {
  type: 'planRepair:success';
  requestId: number;
  result: SmartFixPlanResult;
}

export interface SmartFixApplyProgressResponse {
  type: 'applyRepair:progress';
  requestId: number;
  stage: SmartFixProgressStage;
}

export interface SmartFixApplySuccessResponse {
  type: 'applyRepair:success';
  requestId: number;
  result: SmartFixApplyResult;
}

export interface SmartFixErrorResponse {
  type: 'planRepair:error' | 'applyRepair:error';
  requestId: number;
  message: string;
}

export type SmartFixWorkerResponse =
  | SmartFixPlanSuccessResponse
  | SmartFixApplyProgressResponse
  | SmartFixApplySuccessResponse
  | SmartFixErrorResponse;

self.onmessage = async (event: MessageEvent<SmartFixWorkerRequest>) => {
  const msg = event.data;

  if (msg.type === 'planRepair') {
    try {
      await legacyPdfjsWorkerSrcReady;
      // See preflight.worker.ts for why `unknown` is the correct bridge
      // between the untyped JS engine and our hand-derived types here.
      const result = (await planRepair(new Uint8Array(msg.pdfBytes), msg.userIntent)) as unknown as SmartFixPlanResult;
      const response: SmartFixPlanSuccessResponse = { type: 'planRepair:success', requestId: msg.requestId, result };
      self.postMessage(response);
    } catch (err) {
      const response: SmartFixErrorResponse = {
        type: 'planRepair:error',
        requestId: msg.requestId,
        message: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    }
    return;
  }

  if (msg.type === 'applyRepair') {
    try {
      await legacyPdfjsWorkerSrcReady;
      const result = (await applyRepair(new Uint8Array(msg.pdfBytes), msg.userIntent, {
        ...msg.opts,
        onProgress: (stage: SmartFixProgressStage) => {
          const progress: SmartFixApplyProgressResponse = { type: 'applyRepair:progress', requestId: msg.requestId, stage };
          self.postMessage(progress);
        },
      })) as unknown as SmartFixApplyResult;
      const response: SmartFixApplySuccessResponse = { type: 'applyRepair:success', requestId: msg.requestId, result };
      self.postMessage(response);
    } catch (err) {
      const response: SmartFixErrorResponse = {
        type: 'applyRepair:error',
        requestId: msg.requestId,
        message: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    }
  }
};
