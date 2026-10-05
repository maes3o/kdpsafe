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
  },
})
