import type { ReactNode } from 'react';
import { useI18n } from '../i18n/context';
import type { Verdict } from '../engine/types';
import type { StringKey } from '../i18n/strings';
import { verdictDisplay, type StatusIconKind } from '../engine/verdictDisplay';
import { GLYPH, TONE, type Tone } from './ui';

const KIND_TONE: Record<StatusIconKind, Tone> = { check: 'ready', warning: 'attention', question: 'review', cross: 'error' };
const BODY: Record<Verdict, StringKey> = {
  READY: 'verdictReadyBody',
  NEEDS_ATTENTION: 'verdictNeedsAttentionBody',
  MANUAL_REVIEW_REQUIRED: 'verdictManualReviewBody',
};

/** The one-glance answer. The engine's `verdict` is displayed, never derived.
 * `children` hosts the card's primary action(s). */
export function VerdictCard({
  verdict,
  confirmedCount,
  manualCount,
  children,
}: {
  verdict: Verdict;
  confirmedCount: number;
  manualCount: number;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const d = verdictDisplay(verdict);
  const tone = TONE[KIND_TONE[d.icon]];
  return (
    <section
      role="status"
      aria-label={t('questionIsSafe')}
      data-testid="verdict-card"
      data-verdict={verdict}
      className={`rounded-2xl border p-4 shadow-card ${tone.border} ${tone.soft}`}
    >
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-2xl font-bold text-white ${tone.solid}`}>
          {GLYPH[KIND_TONE[d.icon]]}
        </span>
        <p className={`text-xl font-extrabold uppercase tracking-wide ${tone.text}`}>{t(d.labelKey)}</p>
      </div>
      <p className="mt-3 text-sm text-ink">{t(BODY[verdict])}</p>
      {(confirmedCount > 0 || manualCount > 0) && (
        <ul className="mt-2 space-y-0.5 text-sm font-semibold text-ink">
          {confirmedCount > 0 && <li>{t('countConfirmed', { n: confirmedCount })}</li>}
          {manualCount > 0 && <li>{t('countManual', { n: manualCount })}</li>}
        </ul>
      )}
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}
