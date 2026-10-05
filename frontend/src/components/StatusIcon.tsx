import type { StatusIconKind } from '../engine/verdictDisplay';

const GLYPH: Record<StatusIconKind, string> = {
  check: '✓',
  warning: '!',
  cross: '×',
  question: '?',
};

const COLOR_CLASS: Record<StatusIconKind, string> = {
  check: 'text-status-ready',
  warning: 'text-status-attention',
  cross: 'text-status-error',
  question: 'text-status-review',
};

/**
 * Renders the STATUS RULE glyph + a text label side by side. Color is
 * decorative only here -- `aria-hidden` on the glyph plus the always-
 * rendered text label is what actually communicates state, per the
 * explicit "never color alone" rule.
 */
export function StatusIcon({ kind, label }: { kind: StatusIconKind; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${COLOR_CLASS[kind]}`}>
      <span aria-hidden="true" className="font-mono text-base leading-none">
        {GLYPH[kind]}
      </span>
      <span>{label}</span>
    </span>
  );
}
