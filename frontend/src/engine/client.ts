/**
 * Main-thread client for preflight.worker.ts -- a thin, promise-based
 * wrapper over postMessage so React components never deal with the raw
 * worker protocol or request-id bookkeeping directly.
 */

import type { InspectionResult, PreflightOptions, VerifyAutofixResult } from './types';
import type { EngineApi } from './api';
import type { PreflightWorkerRequest, PreflightWorkerResponse } from './preflight.worker';

interface Pending {
  resolve: (value: never) => void;
  reject: (e: Error) => void;
}

export class PreflightClient implements EngineApi {
  private worker: Worker;
  private nextRequestId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./preflight.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<PreflightWorkerResponse>) => {
      const msg = event.data;
      const entry = this.pending.get(msg.requestId);
      if (!entry) return;
      this.pending.delete(msg.requestId);
      if (msg.type === 'error') entry.reject(new Error(msg.message));
      else (entry.resolve as (v: unknown) => void)(msg.result);
    };
    const failAll = (message: string) => {
      for (const entry of this.pending.values()) entry.reject(new Error(message));
      this.pending.clear();
    };
    this.worker.onerror = (e) => failAll(e.message || 'Worker error');
    this.worker.onmessageerror = () => failAll('Worker message error');
  }

  private call<T>(type: PreflightWorkerRequest['type'], pdfBytes: Uint8Array, options: PreflightOptions): Promise<T> {
    const requestId = this.nextRequestId++;
    // Copy: the transferred buffer is detached on the main thread, and the
    // caller's original bytes must stay intact for later re-runs.
    const copy = pdfBytes.slice().buffer;
    const request: PreflightWorkerRequest = { type, requestId, pdfBytes: copy, options };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (v: never) => void, reject });
      this.worker.postMessage(request, [copy]);
    });
  }

  runPreflight(pdfBytes: Uint8Array, options: PreflightOptions): Promise<InspectionResult> {
    return this.call('runPreflight', pdfBytes, options);
  }

  verifyAutofix(pdfBytes: Uint8Array, options: PreflightOptions): Promise<VerifyAutofixResult> {
    return this.call('verifyAutofix', pdfBytes, options);
  }

  dispose(): void {
    this.worker.terminate();
    for (const entry of this.pending.values()) entry.reject(new Error('disposed'));
    this.pending.clear();
  }
}
