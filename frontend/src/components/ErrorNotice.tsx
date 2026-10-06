import { useI18n } from '../i18n/context';
import type { Failure } from '../workspace/useWorkspace';
import type { StringKey } from '../i18n/strings';
import { btnSecondary } from './ui';

const TITLE: Record<Failure['stage'], { title: StringKey; body: StringKey }> = {
  read: { title: 'errorRead', body: 'errorRead' },
  preflight: { title: 'errorPreflight', body: 'errorPreflightBody' },
  autofix: { title: 'errorAutofix', body: 'errorAutofixBody' },
  verify: { title: 'errorVerify', body: 'errorVerifyBody' },
  normalize: { title: 'errorNormalize', body: 'errorNormalizeBody' },
};

/** A real failure, in plain language, with the raw message one click away.
 * Never rendered alongside a READY the engine did not produce. */
export function ErrorNotice({
  failure,
  onRetry,
  onDismiss,
}: {
  failure: Failure;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const { t } = useI18n();
  const keys = TITLE[failure.stage];
  const title = failure.code === 'notPdf' ? t('errorNotPdf') : t(keys.title);
  return (
    <div role="alert" className="rounded-2xl border border-status-error/50 bg-status-error-soft p-4 shadow-card">
      <p className="flex items-center gap-2 font-semibold text-status-error">
        <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-current font-mono text-xs">×</span>
        {t('verdictError')}: {title}
      </p>
      {failure.stage !== 'read' && <p className="mt-1 text-sm">{t(keys.body)}</p>}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-ink-muted">{t('errorTechnical')}</summary>
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-ink-muted">{failure.message}</pre>
      </details>
      {(onRetry || onDismiss) && (
        <div className="mt-3 flex gap-2">
          {onRetry && (
            <button type="button" className={btnSecondary} onClick={onRetry}>
              {t('tryAgain')}
            </button>
          )}
          {onDismiss && (
            <button type="button" className={btnSecondary} onClick={onDismiss}>
              OK
            </button>
          )}
        </div>
      )}
    </div>
  );
}
