import { useI18n } from '../i18n/context';
import { MARGIN_TABLE_PAGES } from '../workspace/issues';
import { GLYPH, TONE } from './ui';

function Notice({ testId, title, children }: { testId: string; title: string; children: React.ReactNode }) {
  const tone = TONE.review;
  return (
    <section role="note" data-testid={testId} className={`rounded-2xl border p-3.5 text-sm ${tone.border} ${tone.soft}`}>
      <p className={`flex items-center gap-2 font-extrabold ${tone.text}`}>
        <span aria-hidden="true" className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white ${tone.solid}`}>
          {GLYPH.review}
        </span>
        {title}
      </p>
      <div className="mt-1.5 space-y-1">{children}</div>
    </section>
  );
}

/** Autofix rewrites the PDF, which a signature (or encryption) forbids: it is not offered. */
export function AutofixBlockedNotice({ reason }: { reason: 'signed' | 'encrypted' }) {
  const { t } = useI18n();
  return (
    <Notice testId="autofix-blocked" title={t('autofixBlockedTitle')}>
      <p>{t(reason === 'signed' ? 'autofixBlockedSigned' : 'autofixBlockedEncrypted')}</p>
    </Notice>
  );
}

/** < 24 or > 828 pages: the inside-margin table does not cover this book. */
export function PageCountRangeNotice({ pageCount }: { pageCount: number }) {
  const { t } = useI18n();
  return (
    <Notice testId="page-count-range" title={t('pageCountTitle')}>
      <p>{t('pageCountBody', { n: pageCount, min: MARGIN_TABLE_PAGES.min, max: MARGIN_TABLE_PAGES.max })}</p>
      <p className="text-xs text-ink-muted">{t('pageCountNext')}</p>
    </Notice>
  );
}
