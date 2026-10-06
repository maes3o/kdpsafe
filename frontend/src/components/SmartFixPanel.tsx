import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/context';
import { SmartFixClient } from '../engine/smartfixClient';
import { buildHardGateCopy, buildPageCopy } from '../smartfix/copy';
import type { SmartFixApplyResult, SmartFixPlanResult, SmartFixPreviewEntry, SmartFixProgressStage, UserIntent } from '../engine/types';

type PanelState =
  | { phase: 'idle' }
  | { phase: 'analyzing' }
  | { phase: 'planned'; plan: SmartFixPlanResult }
  | { phase: 'applying'; plan: SmartFixPlanResult; stage: SmartFixProgressStage }
  | { phase: 'done'; plan: SmartFixPlanResult; result: SmartFixApplyResult }
  | { phase: 'error'; message: string };

/**
 * Smart Fix UI: ЩО НЕ ТАК -> ЩО ПРОПОНУЄ -> ЧОМУ -> ЩО ЗМІНИТЬСЯ -> PREVIEW
 * -> APPLY -> RE-CHECK -> VERIFIED, wired to the existing Smart Fix
 * engine (lib/smartfix/smartFixEngine.js) via smartfix.worker.ts /
 * smartfixClient.ts. Never re-implements any KDP rule or safety
 * decision -- every card below only displays a plain-language rendering
 * of what planRepair()/applyRepair() already decided.
 */
export function SmartFixPanel({ pdfBytes, userIntent }: { pdfBytes: Uint8Array | null; userIntent: UserIntent }) {
  const { t } = useI18n();
  const clientRef = useRef<SmartFixClient | null>(null);
  const [state, setState] = useState<PanelState>({ phase: 'idle' });
  const [reviewed, setReviewed] = useState(false);
  const [confirmed, setConfirmed] = useState<Set<number>>(new Set());

  function getClient(): SmartFixClient {
    if (!clientRef.current) clientRef.current = new SmartFixClient();
    return clientRef.current;
  }

  useEffect(() => () => clientRef.current?.dispose(), []);

  useEffect(() => {
    if (!pdfBytes) {
      setState({ phase: 'idle' });
      return;
    }
    setReviewed(false);
    setConfirmed(new Set());
    setState({ phase: 'analyzing' });
    const bytesCopy = pdfBytes.slice();
    let cancelled = false;
    getClient()
      .planRepair(bytesCopy.buffer as ArrayBuffer, userIntent)
      .then((plan) => {
        if (!cancelled) setState({ phase: 'planned', plan });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // userIntent is a plain object re-created on every App render in this
    // checkpoint (FRONTEND-01 hardcoded default) -- keying off pdfBytes
    // alone avoids re-running on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfBytes]);

  const actionablePreview = useMemo(() => {
    if (state.phase !== 'planned' && state.phase !== 'applying' && state.phase !== 'done') return [];
    return (state.plan.preview ?? []).filter((e) => e.riskLevel !== 'NONE');
  }, [state]);

  const toggleConfirmed = useCallback((pageIndex: number) => {
    setConfirmed((prev) => {
      const next = new Set(prev);
      if (next.has(pageIndex)) next.delete(pageIndex);
      else next.add(pageIndex);
      return next;
    });
  }, []);

  const handleApply = useCallback(() => {
    if (!pdfBytes || state.phase !== 'planned') return;
    const plan = state.plan;
    setState({ phase: 'applying', plan, stage: 'APPLYING' });
    const bytesCopy = pdfBytes.slice();
    getClient()
      .applyRepair(
        bytesCopy.buffer as ArrayBuffer,
        userIntent,
        { confirmedPageIndexes: Array.from(confirmed) },
        (stage) => setState((prev) => (prev.phase === 'applying' ? { ...prev, stage } : prev))
      )
      .then((result) => setState({ phase: 'done', plan, result }))
      .catch((err: unknown) => setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) }));
  }, [pdfBytes, state, confirmed, userIntent]);

  const handleDownload = useCallback(() => {
    if (state.phase !== 'done' || !state.result.verified) return;
    // TS's DOM lib types ArrayBufferView generically over ArrayBufferLike
    // (which includes SharedArrayBuffer), which Blob's BlobPart does not
    // accept -- copying into a plain ArrayBuffer-backed Uint8Array sidesteps
    // the mismatch without any runtime behavior change.
    const copy: ArrayBuffer = new ArrayBuffer(state.result.outputBytes.length);
    new Uint8Array(copy).set(state.result.outputBytes);
    const blob = new Blob([copy], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kdpsafe-smartfix.pdf';
    a.click();
    URL.revokeObjectURL(url);
  }, [state]);

  if (!pdfBytes || state.phase === 'idle') return null;

  if (state.phase === 'analyzing') {
    return (
      <section className="mt-4 rounded-md border border-border p-4">
        <p className="text-sm text-ink-muted">{t('sfAnalyzing')}</p>
      </section>
    );
  }

  if (state.phase === 'error') {
    return (
      <section className="mt-4 rounded-md border border-status-error/40 bg-status-error/10 p-4">
        <p className="text-sm text-status-error">{state.message}</p>
      </section>
    );
  }

  const plan = state.plan;

  // DO_NOT_TOUCH at the document level (encrypted/signed/unreadable) --
  // the hard gate, never a strategy decision.
  if (plan.documentStatus === 'DO_NOT_TOUCH') {
    return (
      <section className="mt-4 rounded-md border border-status-review/40 bg-status-review/10 p-4">
        <h2 className="mb-2 text-sm font-semibold text-status-review">{t('sfDoNotTouchHeading')}</h2>
        <ul className="list-inside list-disc space-y-1 text-sm text-ink">
          {buildHardGateCopy(t, plan.hardGate).map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      </section>
    );
  }

  if (actionablePreview.length === 0) {
    return (
      <section className="mt-4 rounded-md border border-status-ready/40 bg-status-ready/10 p-4">
        <p className="text-sm text-status-ready">{t('sfAllPagesOk')}</p>
      </section>
    );
  }

  const anyEligibleToApply = actionablePreview.some(
    (e) => e.riskLevel === 'SAFE_AUTOFIX' || (e.riskLevel === 'USER_CONFIRMATION' && confirmed.has(e.pageIndex))
  );

  return (
    <section className="mt-4 rounded-md border border-border p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">{t('sfTitle')}</h2>

      <div className="space-y-4">
        {actionablePreview.map((entry) => (
          <SmartFixPageCard
            key={entry.pageIndex}
            entry={entry}
            userIntent={userIntent}
            reviewed={reviewed}
            confirmed={confirmed.has(entry.pageIndex)}
            onToggleConfirmed={() => toggleConfirmed(entry.pageIndex)}
            disabled={state.phase === 'applying' || state.phase === 'done'}
          />
        ))}
      </div>

      {plan.plans.some((p) => p.chosenStrategy === null && p.problem !== null) && (
        <p className="mt-3 text-xs text-ink-muted">{t('sfSomeSkippedNote')}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        {!reviewed && state.phase === 'planned' && (
          <button
            type="button"
            onClick={() => setReviewed(true)}
            className="rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-bg-panel"
          >
            {t('sfReviewButton')}
          </button>
        )}

        {reviewed && state.phase === 'planned' && (
          <button
            type="button"
            disabled={!anyEligibleToApply}
            onClick={handleApply}
            className="rounded-md bg-status-ready px-3 py-1.5 text-sm font-medium text-bg disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('sfApplySelectedButton')}
          </button>
        )}

        {state.phase === 'applying' && (
          <p className="text-sm text-ink-muted" role="status">
            {state.stage === 'APPLYING' ? t('sfApplying') : t('sfChecking')}
          </p>
        )}
      </div>

      {state.phase === 'done' && (
        <div className="mt-4 border-t border-border pt-3">
          {state.result.verified ? (
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm font-semibold text-status-ready">✓ {t('sfVerified')}</span>
              <button
                type="button"
                onClick={handleDownload}
                className="rounded-md bg-status-ready px-3 py-1.5 text-sm font-medium text-bg"
              >
                {t('sfDownloadButton')}
              </button>
            </div>
          ) : (
            <div>
              <p className="text-sm font-medium text-status-error">{t('sfNotVerified')}</p>
              {state.result.reasons.length > 0 && (
                <>
                  <p className="mt-2 text-xs text-ink-muted">{t('sfNotVerifiedReasons')}</p>
                  <ul className="mt-1 list-inside list-disc text-xs text-ink-muted">
                    {state.result.reasons.map((r, i) => (
                      <li key={i} className="font-mono">
                        {r}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SmartFixPageCard({
  entry,
  userIntent,
  reviewed,
  confirmed,
  onToggleConfirmed,
  disabled,
}: {
  entry: SmartFixPreviewEntry;
  userIntent: UserIntent;
  reviewed: boolean;
  confirmed: boolean;
  onToggleConfirmed: () => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const copy = buildPageCopy(t, entry, userIntent);

  const cardClass =
    copy.status === 'MANUAL_REVIEW'
      ? 'border-status-review/40 bg-status-review/10'
      : copy.riskLevel === 'USER_CONFIRMATION'
        ? 'border-status-attention/40 bg-status-attention/10'
        : 'border-status-ready/40 bg-status-ready/10';

  return (
    <div className={`rounded-md border p-3 ${cardClass}`}>
      <p className="text-xs font-medium text-ink-muted">{t('sfPageLabel', { page: entry.pageIndex + 1 })}</p>

      {copy.status === 'MANUAL_REVIEW' ? (
        <>
          {copy.headline && <p className="mt-1 text-sm font-semibold text-ink">{copy.headline}</p>}
          {copy.current && <p className="text-sm text-ink">{copy.current}</p>}
          {copy.required && <p className="text-sm text-ink">{copy.required}</p>}
          <p className="mt-2 text-sm font-medium text-status-review">{t('sfManualReviewHeading')}</p>
          <p className="text-xs font-medium text-ink-muted">{t('sfManualReviewWhyPrefix')}</p>
          <ul className="list-inside list-disc text-sm text-ink">
            {copy.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      ) : (
        <>
          {copy.headline && <p className="mt-1 text-sm font-semibold text-ink">{copy.headline}</p>}
          {copy.required && <p className="text-sm text-ink">{copy.required}</p>}
          {copy.current && <p className="text-sm text-ink">{copy.current}</p>}
          {copy.proposal && <p className="mt-1 text-sm text-ink">{copy.proposal}</p>}

          {copy.guarantees.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium text-ink-muted">{t('sfGuaranteesHeading')}</p>
              <ul className="list-inside list-disc text-sm text-ink">
                {copy.guarantees.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </div>
          )}

          {reviewed && (
            <div className="mt-2 rounded-md bg-bg-panel p-2">
              <p className="text-xs font-medium text-ink-muted">{t('sfBeforeAfterHeading')}</p>
              <div className="mt-1 flex gap-6 text-sm text-ink">
                <span>
                  {t('sfBefore')}: {trimmed(entry.before.widthIn)} × {trimmed(entry.before.heightIn)} in
                </span>
                {entry.after && (
                  <span>
                    {t('sfAfter')}: {trimmed(entry.after.widthIn)} × {trimmed(entry.after.heightIn)} in
                  </span>
                )}
              </div>
            </div>
          )}

          {copy.needsConfirmation && (
            <div className="mt-2">
              <p className="text-xs font-medium text-status-attention">{t('sfUserConfirmationHeading')}</p>
              <p className="text-xs text-ink-muted">{t('sfUserConfirmationWhy')}</p>
              <label className="mt-1 flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={confirmed} disabled={disabled} onChange={onToggleConfirmed} />
                {t('sfConfirmCheckbox')}
              </label>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function trimmed(valueIn: number): string {
  return (Math.round(valueIn * 1000) / 1000).toString();
}
