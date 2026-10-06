import type { ReactNode } from 'react';
import { useI18n } from '../i18n/context';
import type { Verdict } from '../engine/types';
import { verdictDisplay, type StatusIconKind } from '../engine/verdictDisplay';
import { GLYPH, TONE, type Tone } from './ui';

const KIND_TONE: Record<StatusIconKind, Tone> = { check: 'ready', warning: 'attention', question: 'review', cross: 'error' };

/**
 * "What is going on with my PDF?" -- label, then (for non-READY states) the
 * number that matters, then one plain sentence, then the primary action.
 * The engine's `verdict` and counts are displayed, never derived.
 */
export function VerdictCard({
  verdict,
  confirmedCount,
  manualCount,
  fixableCount,
  children,
}: {
  verdict: Verdict;
  confirmedCount: number;
  manualCount: number;
  /** Engine autofix plans marked applyable (decides which sentence to show). */
  fixableCount: number;
  children?: ReactNode;
}) {
  const { t, tn } = useI18n();
  const d = verdictDisplay(verdict);
  const tone = TONE[KIND_TONE[d.icon]];

  let count: number | null = null;
  let unit = '';
  let body = '';
  let note: string | null = null;
  if (verdict === 'READY') {
    body = t('verdictReadyScope');
  } else if (verdict === 'NEEDS_ATTENTION') {
    count = confirmedCount;
    unit = tn('problemsUnit', confirmedCount);
    body = fixableCount > 0 ? t('verdictAttentionFixable') : t('verdictAttentionSource');
  } else {
    count = manualCount;
    unit = tn('manualUnit', manualCount);
    body = t('verdictManualSafe');
    note = t('verdictManualNote');
  }

  return (
    <section
      role="status"
      aria-label={t('verdictRegionLabel')}
      data-testid="verdict-card"
      data-verdict={verdict}
      className={`rounded-2xl border p-4 shadow-card ${tone.border} ${tone.soft}`}
    >
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-lg font-bold text-white ${tone.solid}`}>
          {GLYPH[KIND_TONE[d.icon]]}
        </span>
        <p className={`text-sm font-extrabold uppercase tracking-widest ${tone.text}`}>{t(d.labelKey)}</p>
      </div>

      {count !== null ? (
        <p className="mt-3 flex items-baseline gap-2.5" data-testid="verdict-headline">
          <span className={`text-5xl font-extrabold leading-none tracking-tight ${tone.text}`}>{count}</span>
          <span className="text-base font-semibold leading-snug text-ink">{unit}</span>
        </p>
      ) : (
        <p className="mt-3 text-xl font-bold leading-snug text-ink" data-testid="verdict-headline">
          {t('verdictReadyHeadline')}
        </p>
      )}

      <p className="mt-2 text-sm text-ink">{body}</p>
      {note && <p className="mt-1 text-xs text-ink-muted">{note}</p>}
      {verdict === 'MANUAL_REVIEW_REQUIRED' && confirmedCount > 0 && (
        <p className="mt-2 text-sm font-semibold text-ink">{t('alsoConfirmed', { n: confirmedCount })}</p>
      )}
      {verdict === 'NEEDS_ATTENTION' && manualCount > 0 && (
        <p className="mt-2 text-sm font-semibold text-ink">{t('alsoManual', { n: manualCount })}</p>
      )}
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}
