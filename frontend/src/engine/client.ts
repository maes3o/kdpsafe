/**
 * Main-thread client for preflight.worker.ts -- a thin, promise-based
 * wrapper over postMessage so React components never deal with the raw
 * worker protocol or request-id bookkeeping directly.
 */

import type { InspectionResult, PreflightOptions } from './types';
import type { PreflightWorkerRequest, PreflightWorkerResponse } from './preflight.worker';

export class PreflightClient {
  private worker: Worker;
  private nextRequestId = 1;
  private pending = new Map<number, { resolve: (r: InspectionResult) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL('./preflight.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<PreflightWorkerResponse>) => {
      const msg = event.data;
      const entry = this.pending.get(msg.requestId);
      if (!entry) return;
      this.pending.delete(msg.requestId);
      if (msg.type === 'runPreflight:success') entry.resolve(msg.result);
      else entry.reject(new Error(msg.message));
    };
  }

  runPreflight(pdfBytes: ArrayBuffer, options: PreflightOptions): Promise<InspectionResult> {
    const requestId = this.nextRequestId++;
    const request: PreflightWorkerRequest = { type: 'runPreflight', requestId, pdfBytes, options };
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      // pdfBytes is transferred, not copied -- the caller must not reuse
      // the ArrayBuffer it passed in afterward.
      this.worker.postMessage(request, [pdfBytes]);
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
