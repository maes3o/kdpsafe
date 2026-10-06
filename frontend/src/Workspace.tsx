import { useMemo, useRef, useState } from 'react';
import type { EngineApi } from './engine/api';
import type { AutofixPlan, BBoxPt, UserIntent } from './engine/types';
import { useI18n } from './i18n/context';
import { useUnit } from './units/context';
import { useWorkspace } from './workspace/useWorkspace';
import { ambiguousEntries, applyablePlans, buildMarks, planId } from './workspace/issues';
import { baseName, buildReport, downloadBlob } from './workspace/report';
import { EmptyState } from './components/EmptyState';
import { BusyState } from './components/BusyState';
import { DocumentDetails, DocumentHeader } from './components/DocumentSummary';
import { SettingsForm } from './components/SettingsForm';
import { VerdictCard } from './components/VerdictCard';
import { VerificationCard } from './components/VerificationCard';
import { OrientationResolver } from './components/OrientationResolver';
import { AutofixPanel } from './components/AutofixPanel';
import { IssueList } from './components/IssueList';
import { DownloadPanel } from './components/DownloadPanel';
import { TechnicalDetails } from './components/TechnicalDetails';
import { ErrorNotice } from './components/ErrorNotice';
import { PdfViewer } from './components/viewer/PdfViewer';
import type { ViewerFocus, ViewerMark } from './components/viewer/types';
import { sectionTitle } from './components/ui';

function intentSummary(intent: UserIntent, t: ReturnType<typeof useI18n>['t'], formatPair: (w: number, h: number) => string): string {
  const dir = intent.readingDirection === 'ltr' ? t('readingLtr') : intent.readingDirection === 'rtl' ? t('readingRtl') : null;
  return [formatPair(intent.trimSize.widthIn, intent.trimSize.heightIn), intent.bleed ? t('bleedYes') : t('bleedNo'), dir]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The single Document Workspace. Left: explanation/action layer; right: the
 * document. It evolves through states instead of navigating. All verdicts,
 * issues, plans and verification states are the engine's, displayed as-is.
 */
export function Workspace({ createEngine }: { createEngine: () => EngineApi }) {
  const { t } = useI18n();
  const { formatPair } = useUnit();
  const ws = useWorkspace(createEngine);
  const { state } = ws;
  const { inspection, fix, intent, busy, failure, file } = state;

  const [focus, setFocus] = useState<ViewerFocus | null>(null);
  // Active issue is only valid for the result it was picked from.
  const [active, setActive] = useState<{ id: string; owner: unknown } | null>(null);
  const nonce = useRef(0);
  const viewerBox = useRef<HTMLDivElement>(null);

  // What the viewer shows: the original, or the engine-produced fixed bytes
  // together with the engine's AFTER result (guides must match the bytes).
  const fixedAvailable = !!(fix && fix.after && fix.applied.length > 0);
  const fixedView = fixedAvailable && state.showFixed;
  const viewBytes = fixedView ? fix!.outputBytes : state.bytes;
  const viewInspection = fixedView ? fix!.after : inspection;
  // What the panel describes: the post-fix reality once a fix was applied.
  const shown = fixedAvailable ? fix!.after : inspection;

  const activeId = active && active.owner === viewInspection ? active.id : null;

  const focusOn = (id: string, pageIndex: number, bbox?: BBoxPt) => {
    setActive({ id, owner: viewInspection });
    setFocus({ pageIndex, bbox, nonce: ++nonce.current });
    if (window.matchMedia?.('(max-width: 1023px)').matches) viewerBox.current?.scrollIntoView({ block: 'start' });
  };

  const activePlanIndex = useMemo(() => {
    if (!inspection || !activeId?.startsWith('p-')) return -1;
    return Number(activeId.slice(2));
  }, [inspection, activeId]);

  const marks = useMemo<ViewerMark[]>(() => {
    const base = buildMarks(viewInspection);
    const plan = !fixedView && viewInspection ? viewInspection.autofixPlans[activePlanIndex] : undefined;
    if (!plan) return base;
    return [
      ...base,
      { id: 'plan-current', pageIndex: plan.pageIndex, bbox: plan.visibleBBoxPt, kind: 'problem' },
      { id: 'plan-fixed', pageIndex: plan.pageIndex, bbox: plan.fixedBBoxPt, kind: 'fixed' },
    ];
  }, [viewInspection, fixedView, activePlanIndex]);

  const onFocusPlan = (id: string, plan: AutofixPlan) => focusOn(id, plan.pageIndex, plan.visibleBBoxPt);

  // ---- empty / loading ------------------------------------------------
  if (!file && busy !== 'reading') {
    const notice = failure ? (failure.code === 'notPdf' ? t('errorNotPdf') : `${t('errorRead')} ${failure.message}`) : null;
    return <EmptyState onFile={ws.openFile} notice={notice} />;
  }
  if (!file) return <div className="p-6"><BusyState title={t('readingFile')} /></div>;

  const applyable = shown ? applyablePlans(inspection!) : [];
  const ambiguous = shown ? ambiguousEntries(shown) : [];
  const working = busy === 'preflight' || busy === 'autofix';
  const canDownloadPdf = fix?.verification === 'VERIFIED';

  const intentSub = intent ? intentSummary(intent, t, formatPair) : null;
  const toolbarExtra = fixedAvailable ? (
    <div role="group" aria-label={`${t('viewOriginal')} / ${t('viewFixed')}`} className="inline-flex overflow-hidden rounded-md border border-border-strong">
      {([false, true] as const).map((fixedMode) => (
        <button
          key={String(fixedMode)}
          type="button"
          aria-pressed={state.showFixed === fixedMode}
          onClick={() => ws.setShowFixed(fixedMode)}
          className={`px-2.5 py-1 text-xs font-medium ${state.showFixed === fixedMode ? 'bg-accent text-accent-ink' : 'bg-bg hover:bg-bg-hover'}`}
        >
          {fixedMode ? t('viewFixed') : t('viewOriginal')}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)] lg:overflow-hidden">
      <div ref={viewerBox} className={`order-1 min-h-0 border-b border-border lg:order-2 lg:h-auto lg:border-b-0 lg:border-l ${inspection ? 'h-[60vh]' : 'h-[38vh]'}`}>
        <PdfViewer
          pdfBytes={viewBytes}
          inspection={viewInspection}
          marks={marks}
          activeMarkId={activeId}
          focus={focus}
          onDocumentInfo={fixedView ? undefined : ws.setDocInfo}
          toolbarExtra={toolbarExtra}
        />
      </div>

      <aside aria-label="KDPSafe" className="order-2 min-h-0 space-y-5 overflow-y-auto bg-bg p-4 lg:order-1">
        <DocumentHeader file={file} onReplace={ws.reset} />

        <details open={!intent} className="rounded-lg border border-border">
          <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3 px-3 py-2">
            <span className={sectionTitle}>{t('settingsTitle')}</span>
            {intentSub && <span className="font-mono text-xs text-ink-muted">{intentSub}</span>}
          </summary>
          <div className="border-t border-border p-3">
            <SettingsForm current={intent} docInfo={state.docInfo} onSubmit={(i) => void ws.runIntent(i)} />
          </div>
        </details>

        {busy === 'preflight' && <BusyState title={t('runningPreflight')} detail={t('runningPreflightDetail')} />}
        {busy === 'autofix' && <BusyState title={t('applyingFix')} detail={t('applyingFixDetail')} />}

        {failure?.stage === 'preflight' && (
          <ErrorNotice failure={failure} onRetry={intent ? () => void ws.runIntent(intent) : undefined} />
        )}

        {shown && inspection && (
          <div inert={working} className={`space-y-5 ${working ? 'opacity-50' : ''}`}>
            <VerdictCard
              verdict={shown.verdict}
              confirmedCount={shown.violations.length}
              manualCount={shown.categories.margins.manualReview.length}
            />
            {busy === 'verifying' && <BusyState title={t('verifying')} />}
            {fix && <VerificationCard fix={fix} onDiscard={ws.discardFix} />}
            {(failure?.stage === 'autofix' || failure?.stage === 'verify') && (
              <ErrorNotice failure={failure} onDismiss={ws.dismissFailure} />
            )}

            {ambiguous.length > 0 && intent && (
              <OrientationResolver
                entries={ambiguous}
                disabled={working}
                onChoose={(readingDirection) => void ws.runIntent({ ...intent, readingDirection })}
              />
            )}

            {!fix && applyable.length > 0 && (
              <AutofixPanel
                plans={inspection.autofixPlans}
                activeId={activePlanIndex >= 0 ? planId(activePlanIndex) : null}
                onFocusPlan={onFocusPlan}
                onApply={() => void ws.applyFix()}
                disabled={working}
              />
            )}

            <DocumentDetails inspection={shown} intent={intent} />

            <IssueList inspection={shown} afterFix={fixedAvailable} activeId={activeId} onFocus={focusOn} />

            <DownloadPanel
              canDownloadPdf={canDownloadPdf}
              pending={busy === 'verifying'}
              onDownloadPdf={() => downloadBlob(fix!.outputBytes.slice(), `${baseName(file.name)}-verified.pdf`, 'application/pdf')}
              onDownloadReport={() =>
                downloadBlob(
                  JSON.stringify(buildReport({ fileName: file.name, intent: intent!, inspection, fix }), null, 2),
                  `${baseName(file.name)}-kdpsafe-report.json`,
                  'application/json'
                )
              }
            />

            <p className="text-xs text-ink-muted">{t('scopeNote')}</p>
            <TechnicalDetails inspection={shown} fix={fix} />
          </div>
        )}
      </aside>
    </div>
  );
}
