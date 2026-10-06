import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: {
    // Our own preflight.worker.ts uses `import` inside the worker (ESM),
    // and is constructed with { type: 'module' } in client.ts -- this must
    // match, or Vite falls back to its legacy IIFE worker format.
    format: 'es',
    rollupOptions: {
      output: {
        // Without this, Rolldown emits TWO separate chunks -- and so two
        // fully independent copies of pdfjs-dist's module code, each
        // with its own GlobalWorkerOptions singleton -- for
        // 'pdfjs-dist/legacy/build/pdf.mjs' when it is dynamically
        // imported from two different call sites within one worker
        // bundle: our own workerSrc-wiring import (an ESM call site) in
        // preflight.worker.ts/smartfix.worker.ts, and lib/margin.js's
        // own lazy import (a CommonJS call site, bundled through a
        // different interop path). That silently breaks the workerSrc
        // wiring below, since the two call sites then read/write two
        // different objects despite resolving the identical specifier.
        // Forcing this one dependency into a single named chunk makes
        // both call sites share the same module instance, as plain ES
        // module semantics intend.
        manualChunks(id) {
          if (id.includes('pdfjs-dist/legacy/build/pdf')) return 'pdfjs-legacy';
        },
      },
    },
  },
})
