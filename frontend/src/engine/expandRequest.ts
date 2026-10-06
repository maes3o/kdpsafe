import type { ExpandAnchor } from './types';

/**
 * What the worker forwards to the engine for an Expand-page request: ONLY the
 * anchor 'keep-origin' and the confirmation flag. Anything else (a centered
 * anchor, the engine's research switch, unknown fields) is dropped, so the
 * production UI can never reach the research-only paths.
 */
export function sanitizeExpandRequest(req: unknown): { anchor: ExpandAnchor | null; confirmed: boolean } | undefined {
  if (!req || typeof req !== 'object') return undefined;
  const r = req as { anchor?: unknown; confirmed?: unknown };
  return { anchor: r.anchor === 'keep-origin' ? 'keep-origin' : null, confirmed: r.confirmed === true };
}

/**
 * The ONLY options the worker hands to the engine: the user's intent and the
 * sanitized Expand request. Everything else a caller might add -- notably
 * `pageContext` (which would let a request choose the page count and with it
 * the KDP gutter-margin row, changing a verdict) -- is dropped here.
 */
export function buildEngineOptions(options: unknown): { userIntent: unknown; expandPage: ReturnType<typeof sanitizeExpandRequest> } {
  const o = (options && typeof options === 'object' ? options : {}) as { userIntent?: unknown; expandPage?: unknown };
  return { userIntent: o.userIntent, expandPage: sanitizeExpandRequest(o.expandPage) };
}
