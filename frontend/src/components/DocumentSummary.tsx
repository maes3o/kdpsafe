import { useI18n } from '../i18n/context';
import { useUnit } from '../units/context';
import type { InspectionResult, UserIntent } from '../engine/types';

/** Pages / trim size / bleed -- three compact facts under the verdict. */
export function DocumentStats({ inspection, intent }: { inspection: InspectionResult; intent: UserIntent | null }) {
  const { t } = useI18n();
  const { formatPair } = useUnit();
  const cell = 'flex-1 px-3 py-2.5';
  return (
    <dl className="flex divide-x divide-border rounded-2xl border border-border bg-bg shadow-card">
      <div className={cell}>
        <dt className="text-xs text-ink-muted">{t('documentPages')}</dt>
        <dd className="mt-0.5 text-lg font-semibold">{inspection.document.pageCount}</dd>
      </div>
      <div className={cell}>
        <dt className="text-xs text-ink-muted">{t('documentTrim')}</dt>
        <dd className="mt-0.5 font-mono text-sm font-semibold leading-7">
          {formatPair(inspection.document.trimWidthIn, inspection.document.trimHeightIn)}
        </dd>
      </div>
      <div className={cell}>
        <dt className="text-xs text-ink-muted">{t('documentBleed')}</dt>
        <dd className="mt-0.5 text-lg font-semibold">{intent ? (intent.bleed ? t('statBleedYes') : t('statBleedNo')) : '–'}</dd>
      </div>
    </dl>
  );
}

/** Geometry status and notes (Details tab). Partial geometry is information,
 * never a failure. */
export function GeometryDetails({ inspection }: { inspection: InspectionResult }) {
  const { t } = useI18n();
  const geo = inspection.geometry.status;
  return (
    <section aria-label={t('documentGeometry')} className="space-y-2 rounded-2xl border border-border bg-bg p-4 text-sm shadow-card">
      <p>
        <span className="text-ink-muted">{t('documentGeometry')}: </span>
        <span className="font-semibold">
          {geo === 'complete' && t('geometryComplete')}
          {geo === 'partial' && t('geometryPartial')}
          {geo === 'unavailable' && t('geometryUnavailable')}
        </span>
      </p>
      {geo === 'partial' && <p className="text-xs text-ink-muted">{t('geometryPartialHint')}</p>}
      {geo === 'unavailable' && <p className="text-xs text-ink-muted">{t('geometryUnavailableHint')}</p>}
      {!inspection.document.pageSizeConsistent && <p className="text-xs text-ink-muted">{t('pagesInconsistent')}</p>}
    </section>
  );
}
