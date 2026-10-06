import { useI18n } from '../i18n/context';
import { useUnit } from '../units/context';
import type { InspectionResult, PageGeometryAssessment, UserIntent } from '../engine/types';

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
        <dt className="text-xs text-ink-muted">{t('documentPageSize')}</dt>
        <dd className="mt-0.5 font-mono text-sm font-semibold leading-7">
          {formatPair(inspection.document.pageWidthIn, inspection.document.pageHeightIn)}
        </dd>
      </div>
      <div className={cell}>
        <dt className="text-xs text-ink-muted">{t('documentBleed')}</dt>
        <dd className="mt-0.5 text-lg font-semibold">{intent ? (intent.bleed ? t('statBleedYes') : t('statBleedNo')) : '–'}</dd>
      </div>
    </dl>
  );
}

/** Page size / selected trim / TrimBox / bleed, plus geometry status and
 * notes (Details tab). Partial geometry is information, never a failure. */
export function GeometryDetails({
  inspection,
  geometry,
  intent,
}: {
  inspection: InspectionResult;
  geometry: PageGeometryAssessment | null;
  intent: UserIntent | null;
}) {
  const { t } = useI18n();
  const { formatPair } = useUnit();
  const geo = inspection.geometry.status;
  const rotated = geometry?.pages.some((p) => p.rotationDeg !== 0) ?? false;
  const row = 'flex justify-between gap-3';
  return (
    <section aria-label={t('geoDetailsTitle')} className="space-y-3 rounded-2xl border border-border bg-bg p-4 text-sm shadow-card">
      <dl className="space-y-1.5" data-testid="geometry-details">
        <div className={row}>
          <dt className="text-ink-muted">{t('documentPageSize')}</dt>
          <dd className="font-mono">{formatPair(inspection.document.pageWidthIn, inspection.document.pageHeightIn)}</dd>
        </div>
        {intent && (
          <div className={row}>
            <dt className="text-ink-muted">{t('geoSelected')}</dt>
            <dd className="font-mono">{formatPair(intent.trimSize.widthIn, intent.trimSize.heightIn)}</dd>
          </div>
        )}
        {geometry && (
          <div className={row}>
            <dt className="text-ink-muted">{t('geoTrimBox')}</dt>
            <dd>
              {geometry.trimBox === 'explicit' && t('geoTrimBoxExplicit')}
              {geometry.trimBox === 'missing' && t('geoTrimBoxMissing')}
              {geometry.trimBox === 'mixed' && t('geoTrimBoxMixed')}
            </dd>
          </div>
        )}
        {intent && (
          <div className={row}>
            <dt className="text-ink-muted">{t('documentBleed')}</dt>
            <dd>{intent.bleed ? t('bleedYes') : t('bleedNo')}</dd>
          </div>
        )}
        {rotated && (
          <div className={row}>
            <dt className="text-ink-muted">{t('geoRotation')}</dt>
            <dd>/Rotate</dd>
          </div>
        )}
        <div className={row}>
          <dt className="text-ink-muted">{t('documentGeometry')}</dt>
          <dd className="font-semibold">
            {geo === 'complete' && t('geometryComplete')}
            {geo === 'partial' && t('geometryPartial')}
            {geo === 'unavailable' && t('geometryUnavailable')}
          </dd>
        </div>
      </dl>
      {geo === 'partial' && <p className="text-xs text-ink-muted">{t('geometryPartialHint')}</p>}
      {geo === 'unavailable' && <p className="text-xs text-ink-muted">{t('geometryUnavailableHint')}</p>}
      {!inspection.document.pageSizeConsistent && <p className="text-xs text-ink-muted">{t('pagesInconsistent')}</p>}
    </section>
  );
}
