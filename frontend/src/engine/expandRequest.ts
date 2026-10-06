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
