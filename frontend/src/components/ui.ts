/** Shared class strings (token-based). Kept in one place so components stay
 * visually consistent without a component library. */

export const btnPrimary =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-accent-ink shadow-sm hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50';
/** Dark/ink action (e.g. download). */
export const btnDark =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40';
export const btnSecondary =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-border-strong bg-bg px-3.5 py-2 text-sm font-medium text-ink hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50';
export const btnGhost =
  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm font-medium text-accent hover:bg-accent-soft disabled:opacity-50';
export const inputCls =
  'h-11 w-full rounded-xl border border-border-strong bg-bg px-3 font-mono text-sm text-ink placeholder:text-ink-muted';
export const card = 'rounded-2xl border border-border bg-bg shadow-card';
export const sectionTitle = 'text-xs font-semibold uppercase tracking-wide text-ink-muted';

export type Tone = 'ready' | 'attention' | 'review' | 'error';

export const TONE: Record<Tone, { text: string; soft: string; border: string; solid: string }> = {
  ready: { text: 'text-status-ready', soft: 'bg-status-ready-soft', border: 'border-status-ready/40', solid: 'bg-status-ready-solid' },
  attention: { text: 'text-status-attention', soft: 'bg-status-attention-soft', border: 'border-status-attention/40', solid: 'bg-status-attention-solid' },
  review: { text: 'text-status-review', soft: 'bg-status-review-soft', border: 'border-status-review/40', solid: 'bg-status-review-solid' },
  error: { text: 'text-status-error', soft: 'bg-status-error-soft', border: 'border-status-error/40', solid: 'bg-status-error-solid' },
};

export const GLYPH: Record<Tone, string> = { ready: '✓', attention: '!', review: '?', error: '×' };
