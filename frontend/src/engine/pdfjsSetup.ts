/**
 * Inside a Web Worker, pdf.js (used by lib/margin.js via a dynamic import of
 * its legacy build) runs its parser in "fake worker" mode on this thread.
 * Node never needs a worker source, but a browser worker does. pdf.js
 * supports exactly this case: if `globalThis.pdfjsWorker` already holds the
 * worker module, no workerSrc is needed -- and, unlike setting
 * GlobalWorkerOptions.workerSrc, it works no matter how many copies of
 * pdf.js the bundler emits. (Done lazily, not via top-level await: the
 * worker's message handler must be installed synchronously.)
 */
let ready: Promise<void> | null = null;

export function configurePdfjs(): Promise<void> {
  ready ??= import('pdfjs-dist/legacy/build/pdf.worker.mjs').then((workerModule) => {
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = workerModule;
  });
  return ready;
}
