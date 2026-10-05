import { useI18n } from '../i18n/context';
import type { AmbiguousOrientationEntry } from '../engine/types';
import { pageNumbers } from '../workspace/issues';
import { btnSecondary, TONE } from './ui';

/** LEM_ORIENTATION_AMBIGUOUS is a question, not a verdict: the user's answer
 * becomes userIntent.readingDirection and the REAL preflight runs again. */
export function OrientationResolver({
  entries,
  onChoose,
  disabled,
}: {
  entries: AmbiguousOrientationEntry[];
  onChoose: (direction: 'ltr' | 'rtl') => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const pages = pageNumbers(entries);
  const list = pages.length > 8 ? `${pages.slice(0, 8).join(', ')}…` : pages.join(', ');
  return (
    <section
      data-testid="orientation-resolver"
      aria-labelledby="orient-title"
      className={`rounded-lg border p-4 ${TONE.review.border} ${TONE.review.soft}`}
    >
      <h3 id="orient-title" className="font-semibold">
        {t('orientTitle')}
      </h3>
      <p className="mt-1 text-sm">{t('orientBody')}</p>
      <p className="mt-1 text-xs text-ink-muted">
        {t('orientAffected', { n: entries.length, pages: t('pagesList', { list }) })}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={btnSecondary} disabled={disabled} onClick={() => onChoose('ltr')}>
          {t('orientChooseLtr')}
        </button>
        <button type="button" className={btnSecondary} disabled={disabled} onClick={() => onChoose('rtl')}>
          {t('orientChooseRtl')}
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-muted">{t('orientRerunNote')}</p>
    </section>
  );
}
