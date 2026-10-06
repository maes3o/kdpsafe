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

/** The one-glance answer. The engine's `verdict` is displayed, never derived. */
export function VerdictCard({
  verdict,
  confirmedCount,
  manualCount,
}: {
  verdict: Verdict;
  confirmedCount: number;
  manualCount: number;
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
      className={`rounded-lg border-2 p-4 ${tone.border} ${tone.soft}`}
    >
      <div className={`flex items-center gap-3 ${tone.text}`}>
        <span aria-hidden="true" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-current font-mono text-xl font-bold">
          {GLYPH[KIND_TONE[d.icon]]}
        </span>
        <p className="font-display text-2xl font-bold tracking-tight">{t(d.labelKey)}</p>
      </div>
      <p className="mt-2 text-sm text-ink">{t(BODY[verdict])}</p>
      {(confirmedCount > 0 || manualCount > 0) && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium text-ink">
          {confirmedCount > 0 && <li>{t('countConfirmed', { n: confirmedCount })}</li>}
          {manualCount > 0 && <li>{t('countManual', { n: manualCount })}</li>}
        </ul>
      )}
    </section>
  );
}
