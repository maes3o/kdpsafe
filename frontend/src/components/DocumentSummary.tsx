import { useI18n } from '../i18n/context';
import type { InspectionResult, UserIntent } from '../engine/types';
import { btnGhost } from './ui';

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "What document am I checking?" -- file, pages, trim, bleed, geometry. */
export function DocumentHeader({ file, onReplace }: { file: { name: string; size: number }; onReplace: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="truncate font-medium" title={file.name}>
          {file.name}
        </p>
        <p className="font-mono text-xs text-ink-muted">{formatSize(file.size)}</p>
      </div>
      <button type="button" className={btnGhost} onClick={onReplace}>
        {t('replaceFile')}
      </button>
    </div>
  );
}

/** Pages / trim / bleed / geometry. Shown below the verdict so the answer
 * comes first. */
export function DocumentDetails({ inspection, intent }: { inspection: InspectionResult; intent: UserIntent | null }) {
  const { t, formatNumber } = useI18n();
  const geo = inspection.geometry.status;
  return (
    <section aria-label={t('documentGeometry')} className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-ink-muted">{t('documentPages')}</dt>
          <dd className="font-mono">{inspection.document.pageCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">{t('documentTrim')}</dt>
          <dd className="font-mono">
            {formatNumber(inspection.document.trimWidthIn, 3)} × {formatNumber(inspection.document.trimHeightIn, 3)} {t('inchesShort')}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">{t('documentBleed')}</dt>
          <dd>{intent ? (intent.bleed ? t('bleedYes') : t('bleedNo')) : '–'}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">{t('documentGeometry')}</dt>
          <dd>
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
