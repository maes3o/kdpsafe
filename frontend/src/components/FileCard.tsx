import { useI18n } from '../i18n/context';
import { IconClose, PdfBadge } from './icons';

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "What document am I checking?" -- name, pages, size, and a remove button. */
export function FileCard({ file, pageCount, onRemove }: { file: { name: string; size: number }; pageCount: number | null; onRemove: () => void }) {
  const { t } = useI18n();
  return (
    <section aria-label={file.name} className="flex items-center gap-3 rounded-2xl border border-border bg-bg p-3 shadow-card">
      <PdfBadge />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold" title={file.name}>
          {file.name}
        </p>
        <p className="font-mono text-xs text-ink-muted">
          {pageCount !== null && <>{t('pagesCount', { n: pageCount })} · </>}
          {formatSize(file.size)}
        </p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('replaceFile')}
        title={t('replaceFile')}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-bg-hover hover:text-ink"
      >
        <IconClose size={18} />
      </button>
    </section>
  );
}
