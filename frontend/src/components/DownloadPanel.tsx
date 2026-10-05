import { useI18n } from '../i18n/context';
import { btnPrimary, btnSecondary, sectionTitle } from './ui';

/** The verified PDF is offered only when the engine's verification says
 * VERIFIED; the report (the engine's own results as JSON) whenever a result
 * exists. */
export function DownloadPanel({
  canDownloadPdf,
  pending,
  onDownloadPdf,
  onDownloadReport,
}: {
  canDownloadPdf: boolean;
  pending: boolean;
  onDownloadPdf: () => void;
  onDownloadReport: () => void;
}) {
  const { t } = useI18n();
  return (
    <section aria-labelledby="dl-title" className="space-y-2">
      <h3 id="dl-title" className={sectionTitle}>
        {t('downloadsTitle')}
      </h3>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnPrimary} disabled={!canDownloadPdf} onClick={onDownloadPdf}>
          {t('downloadPdf')}
        </button>
        <button type="button" className={btnSecondary} onClick={onDownloadReport}>
          {t('downloadReport')}
        </button>
      </div>
      {!canDownloadPdf && (
        <p className="text-xs text-ink-muted">{pending ? t('verifying_pending') : t('downloadLockedHint')}</p>
      )}
    </section>
  );
}
