import { useI18n } from '../i18n/context';
import type { VerifyAutofixResult } from '../engine/types';
import { skipReasonLabel, verificationReasonLabel } from '../i18n/labels';
import { btnSecondary, GLYPH, TONE } from './ui';

/** Shows the engine's `verification` (VERIFIED / not). This is distinct from
 * the document `verdict` (READY ...): VERIFIED comes only from
 * verifyAutofix(), including the intentional `after: null` case for an
 * already-READY document. */
export function VerificationCard({ fix, onDiscard }: { fix: VerifyAutofixResult; onDiscard: () => void }) {
  const { t } = useI18n();
  const verified = fix.verification === 'VERIFIED';
  const tone = TONE[verified ? 'ready' : 'attention'];
  const glyph = GLYPH[verified ? 'ready' : 'attention'];
  return (
    <section
      role="status"
      data-testid="verification-card"
      data-verification={fix.verification}
      data-after={fix.after === null ? 'null' : 'result'}
      className={`rounded-lg border p-3 ${tone.border} ${tone.soft}`}
    >
      <p className={`flex items-center gap-2 font-display text-base font-bold tracking-wide ${tone.text}`}>
        <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-current font-mono text-xs">
          {glyph}
        </span>
        {verified ? t('verifiedTitle') : t('notVerifiedTitle')}
      </p>

      {verified ? (
        <p className="mt-1 text-sm">{fix.after === null ? t('verifiedAlreadyReady') : t('verifiedAfterFix')}</p>
      ) : (
        <>
          <p className="mt-1 text-sm">{t('notVerifiedBody')}</p>
          {fix.reasons.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-sm">
              {fix.reasons.map((r) => (
                <li key={r}>{verificationReasonLabel(t, r)}</li>
              ))}
            </ul>
          )}
        </>
      )}

      {(fix.applied.length > 0 || fix.skipped.length > 0) && (
        <div className="mt-2 space-y-1 text-sm text-ink-muted">
          {fix.applied.length > 0 && <p>{t('appliedChanges', { n: fix.applied.length })}</p>}
          {fix.skipped.length > 0 && (
            <>
              <p>{t('skippedChanges', { n: fix.skipped.length })}</p>
              <ul className="list-inside list-disc">
                {fix.skipped.map((s, i) => (
                  <li key={i}>
                    {t('pageNumber', { page: s.plan.pageIndex + 1 })}: {skipReasonLabel(t, s.reason)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {!verified && (
        <button type="button" className={`${btnSecondary} mt-3`} onClick={onDiscard}>
          {t('discardFix')}
        </button>
      )}
    </section>
  );
}
