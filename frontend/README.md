# KDPSafe frontend

React 19 + TypeScript + Vite. All compliance logic lives in the frozen Phase 1
engine (`../lib`); this app only collects `userIntent`, calls the engine in a
Web Worker, and displays what it returns.

- `npm run dev` / `npm run build` (typecheck + build)
- `npm test` — vitest (UI states, flows, i18n, theme)
- `npm run e2e` — real-browser smoke test (Playwright + Chromium) against
  `vite preview`: `node e2e/make-fixtures.cjs && npm run build && npx vite preview --port 4173`,
  then `PLAYWRIGHT_PATH=<path to playwright> npm run e2e`.

Browser autofix: the engine's autofix writer needs Node's `Buffer`/`zlib`. The
worker provides `buffer` and aliases `zlib` to a fflate-backed shim
(`src/engine/zlibShim.ts`); the engine itself is unmodified.
