import { useI18n } from '../i18n/context';
import { verdictDisplay } from '../engine/verdictDisplay';
import { StatusIcon } from './StatusIcon';
import type { Verdict } from '../engine/types';

const BANNER_CLASS: Record<Verdict, string> = {
  READY: 'border-status-ready/40 bg-status-ready/10',
  NEEDS_ATTENTION: 'border-status-attention/40 bg-status-attention/10',
  MANUAL_REVIEW_REQUIRED: 'border-status-review/40 bg-status-review/10',
};

export function VerdictBanner({ verdict }: { verdict: Verdict }) {
  const { t } = useI18n();
  const display = verdictDisplay(verdict);

  return (
    <div className={`rounded-md border px-4 py-3 ${BANNER_CLASS[verdict]}`}>
      <StatusIcon kind={display.icon} label={t(display.labelKey)} />
    </div>
  );
}
