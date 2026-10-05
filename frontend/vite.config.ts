import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // The frozen engine's autofix writer requires Node's zlib; in the
      // browser it gets a zlib-format deflate from fflate (see zlibShim.ts).
      { find: /^zlib$/, replacement: fileURLToPath(new URL('./src/engine/zlibShim.ts', import.meta.url)) },
    ],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
  worker: {
    // Our own preflight.worker.ts uses `import` inside the worker (ESM),
    // and is constructed with { type: 'module' } in client.ts -- this must
    // match, or Vite falls back to its legacy IIFE worker format.
    format: 'es',
  },
})
