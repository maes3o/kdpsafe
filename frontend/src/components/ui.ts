/** Shared class strings (token-based). Kept in one place so components stay
 * visually consistent without a component library. */

export const btnPrimary =
  'inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
export const btnSecondary =
  'inline-flex items-center justify-center gap-2 rounded-md border border-border-strong bg-bg px-3 py-1.5 text-sm font-medium text-ink hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50';
export const btnGhost =
  'inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-accent hover:bg-bg-hover disabled:opacity-50';
export const inputCls =
  'h-9 w-full rounded-md border border-border-strong bg-bg px-2.5 font-mono text-sm text-ink placeholder:text-ink-muted';
export const sectionTitle = 'text-xs font-semibold uppercase tracking-wide text-ink-muted';

export type Tone = 'ready' | 'attention' | 'review' | 'error';

export const TONE: Record<Tone, { text: string; soft: string; border: string }> = {
  ready: { text: 'text-status-ready', soft: 'bg-status-ready-soft', border: 'border-status-ready' },
  attention: { text: 'text-status-attention', soft: 'bg-status-attention-soft', border: 'border-status-attention' },
  review: { text: 'text-status-review', soft: 'bg-status-review-soft', border: 'border-status-review' },
  error: { text: 'text-status-error', soft: 'bg-status-error-soft', border: 'border-status-error' },
};

export const GLYPH: Record<Tone, string> = { ready: '✓', attention: '!', review: '?', error: '×' };
