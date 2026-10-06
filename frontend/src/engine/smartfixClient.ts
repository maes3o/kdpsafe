/**
 * Main-thread client for smartfix.worker.ts -- mirrors PreflightClient's
 * pattern (client.ts) exactly: a thin, promise-based wrapper over
 * postMessage/request-id bookkeeping, plus an onProgress callback for
 * applyRepair()'s APPLYING/CHECKING stages so the UI can show them live.
 */

import type { SmartFixApplyOptions, SmartFixApplyResult, SmartFixPlanResult, SmartFixProgressStage, UserIntent } from './types';
import type { SmartFixWorkerRequest, SmartFixWorkerResponse } from './smartfix.worker';

type PlanPending = { resolve: (r: SmartFixPlanResult) => void; reject: (e: Error) => void };
type ApplyPending = {
  resolve: (r: SmartFixApplyResult) => void;
  reject: (e: Error) => void;
  onProgress?: (stage: SmartFixProgressStage) => void;
};

export class SmartFixClient {
  private worker: Worker;
  private nextRequestId = 1;
  private pendingPlan = new Map<number, PlanPending>();
  private pendingApply = new Map<number, ApplyPending>();

  constructor() {
    this.worker = new Worker(new URL('./smartfix.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<SmartFixWorkerResponse>) => {
      const msg = event.data;

      if (msg.type === 'planRepair:success') {
        const entry = this.pendingPlan.get(msg.requestId);
        if (!entry) return;
        this.pendingPlan.delete(msg.requestId);
        entry.resolve(msg.result);
        return;
      }
      if (msg.type === 'planRepair:error') {
        const entry = this.pendingPlan.get(msg.requestId);
        if (!entry) return;
        this.pendingPlan.delete(msg.requestId);
        entry.reject(new Error(msg.message));
        return;
      }
      if (msg.type === 'applyRepair:progress') {
        const entry = this.pendingApply.get(msg.requestId);
        entry?.onProgress?.(msg.stage);
        return;
      }
      if (msg.type === 'applyRepair:success') {
        const entry = this.pendingApply.get(msg.requestId);
        if (!entry) return;
        this.pendingApply.delete(msg.requestId);
        entry.resolve(msg.result);
        return;
      }
      if (msg.type === 'applyRepair:error') {
        const entry = this.pendingApply.get(msg.requestId);
        if (!entry) return;
        this.pendingApply.delete(msg.requestId);
        entry.reject(new Error(msg.message));
      }
    };
  }

  planRepair(pdfBytes: ArrayBuffer, userIntent: UserIntent): Promise<SmartFixPlanResult> {
    const requestId = this.nextRequestId++;
    const request: SmartFixWorkerRequest = { type: 'planRepair', requestId, pdfBytes, userIntent };
    return new Promise((resolve, reject) => {
      this.pendingPlan.set(requestId, { resolve, reject });
      // pdfBytes is transferred, not copied -- the caller must not reuse
      // the ArrayBuffer it passed in afterward.
      this.worker.postMessage(request, [pdfBytes]);
    });
  }

  applyRepair(
    pdfBytes: ArrayBuffer,
    userIntent: UserIntent,
    opts?: SmartFixApplyOptions,
    onProgress?: (stage: SmartFixProgressStage) => void
  ): Promise<SmartFixApplyResult> {
    const requestId = this.nextRequestId++;
    const request: SmartFixWorkerRequest = { type: 'applyRepair', requestId, pdfBytes, userIntent, opts };
    return new Promise((resolve, reject) => {
      this.pendingApply.set(requestId, { resolve, reject, onProgress });
      this.worker.postMessage(request, [pdfBytes]);
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pendingPlan.clear();
    this.pendingApply.clear();
  }
}
