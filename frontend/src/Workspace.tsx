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
import { DocumentStats, GeometryDetails } from './components/DocumentSummary';
import { FileCard } from './components/FileCard';
import { TabPanel, Tabs } from './components/Tabs';
import { useMediaQuery } from './hooks';
import { IconArrowDown, IconBack, IconDownload } from './components/icons';
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
import { btnDark, card } from './components/ui';

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
  const [tab, setTab] = useState<'issues' | 'preview' | 'details'>('issues');
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const nonce = useRef(0);
  const tabsRef = useRef<HTMLDivElement>(null);
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
    // On narrow screens the document lives in its own tab.
    if (!isDesktop) {
      setTab('preview');
      viewerBox.current?.scrollIntoView?.({ block: 'start' });
    }
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
  if (!file) return <div className="mx-auto w-full max-w-md p-6"><BusyState title={t('readingFile')} /></div>;

  const applyable = shown ? applyablePlans(inspection!) : [];
  const ambiguous = shown ? ambiguousEntries(shown) : [];
  const working = busy === 'preflight' || busy === 'autofix';
  const canDownloadPdf = fix?.verification === 'VERIFIED';
  const intentSub = intent ? intentSummary(intent, t, formatPair) : null;

  // The preview tab only exists on narrow screens (desktop always shows it).
  const activeTab = isDesktop && tab === 'preview' ? 'issues' : tab;
  const issueCount = shown ? shown.violations.length + shown.categories.margins.manualReview.length : 0;
  const viewerOnNarrow = !!inspection && activeTab === 'preview';

  const toolbarExtra = fixedAvailable ? (
    <div role="group" aria-label={`${t('viewOriginal')} / ${t('viewFixed')}`} className="inline-flex rounded-full bg-bg-hover p-0.5">
      {([false, true] as const).map((fixedMode) => (
        <button
          key={String(fixedMode)}
          type="button"
          aria-pressed={state.showFixed === fixedMode}
          onClick={() => ws.setShowFixed(fixedMode)}
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${state.showFixed === fixedMode ? 'bg-bg text-accent shadow-sm' : 'text-ink-muted'}`}
        >
          {fixedMode ? t('viewFixed') : t('viewOriginal')}
        </button>
      ))}
    </div>
  ) : null;

  const downloadPdf = () => downloadBlob(fix!.outputBytes.slice(), `${baseName(file.name)}-verified.pdf`, 'application/pdf');
  const downloadReport = () =>
    downloadBlob(
      JSON.stringify(buildReport({ fileName: file.name, intent: intent!, inspection: inspection!, fix }), null, 2),
      `${baseName(file.name)}-kdpsafe-report.json`,
      'application/json'
    );

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(380px,460px)_minmax(0,1fr)] lg:overflow-hidden">
      <aside aria-label="KDPSafe" className={`order-1 min-h-0 space-y-4 bg-bg-panel p-4 lg:overflow-y-auto ${viewerOnNarrow ? 'hidden' : ''}`}>
        <FileCard file={file} pageCount={state.docInfo?.pageCount ?? inspection?.document.pageCount ?? null} onRemove={ws.reset} />

        <details open={!intent} className={card}>
          <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3 px-4 py-3">
            <span className="text-base font-semibold">{t('settingsTitle')}</span>
            {intentSub && <span className="font-mono text-xs text-ink-muted">{intentSub}</span>}
          </summary>
          <div className="border-t border-border p-4">
            <SettingsForm current={intent} docInfo={state.docInfo} onSubmit={(i) => void ws.runIntent(i)} />
          </div>
        </details>

        {busy === 'preflight' && <BusyState title={t('progressTitle')} detail={t('runningPreflightDetail')} />}
        {busy === 'autofix' && <BusyState title={t('applyingFix')} detail={t('applyingFixDetail')} />}

        {failure?.stage === 'preflight' && (
          <ErrorNotice failure={failure} onRetry={intent ? () => void ws.runIntent(intent) : undefined} />
        )}

        {shown && inspection && (
          <div inert={working} className={`space-y-4 ${working ? 'opacity-50' : ''}`}>
            <VerdictCard
              verdict={shown.verdict}
              confirmedCount={shown.violations.length}
              manualCount={shown.categories.margins.manualReview.length}
              fixableCount={applyable.length}
            >
              {canDownloadPdf && (
                <button type="button" className={`${btnDark} w-full`} onClick={downloadPdf}>
                  <IconDownload size={18} />
                  {t('downloadPdf')}
                </button>
              )}
              {!canDownloadPdf && issueCount > 0 && (
                <button type="button" className={`${btnDark} w-full`} onClick={() => setTab('issues')}>
                  {t('showIssues')}
                  <IconArrowDown size={18} />
                </button>
              )}
            </VerdictCard>

            {busy === 'verifying' && <BusyState title={t('verifying')} />}
            {fix && <VerificationCard fix={fix} onDiscard={ws.discardFix} />}
            {(failure?.stage === 'autofix' || failure?.stage === 'verify') && (
              <ErrorNotice failure={failure} onDismiss={ws.dismissFailure} />
            )}

            <DocumentStats inspection={shown} intent={intent} />

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

            <div ref={tabsRef} className="scroll-mt-16">
            <Tabs
              label={t('tabIssues')}
              active={activeTab}
              onChange={setTab}
              tabs={[
                { id: 'issues', label: t('tabIssues'), badge: issueCount },
                ...(isDesktop ? [] : [{ id: 'preview' as const, label: t('tabPreview') }]),
                { id: 'details', label: t('tabDetails') },
              ]}
            />
            </div>

            {activeTab === 'issues' && (
              <TabPanel id="issues">
                <IssueList inspection={shown} afterFix={fixedAvailable} activeId={activeId} onFocus={focusOn} />
              </TabPanel>
            )}
            {activeTab === 'details' && (
              <TabPanel id="details">
                <GeometryDetails inspection={shown} />
                <DownloadPanel canDownloadPdf={canDownloadPdf} pending={busy === 'verifying'} onDownloadPdf={downloadPdf} onDownloadReport={downloadReport} />
                <p className="text-xs text-ink-muted">{t('scopeNote')}</p>
                <TechnicalDetails inspection={shown} fix={fix} />
              </TabPanel>
            )}
          </div>
        )}
      </aside>

      {/* Always mounted (it loads the PDF and reports its page size); shown
          beside the panel on desktop, as the Preview tab on narrow screens. */}
      <div
        ref={viewerBox}
        id="panel-preview"
        className={`order-2 min-h-0 flex-col border-t border-border lg:flex lg:h-auto lg:border-l lg:border-t-0 ${viewerOnNarrow ? 'flex h-[calc(100dvh-3.5rem)]' : 'hidden'}`}
      >
        {/* Narrow screens: an explicit way back to the results. */}
        <div className="flex shrink-0 items-center border-b border-border bg-bg px-3 py-1.5 lg:hidden">
          <button
            type="button"
            onClick={() => {
              setTab('issues');
              requestAnimationFrame(() => tabsRef.current?.scrollIntoView?.({ block: 'start' }));
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-semibold text-accent hover:bg-accent-soft"
          >
            <IconBack size={18} />
            {t('backToResults')}
          </button>
        </div>
        <div className="min-h-0 flex-1">
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
      </div>
    </div>
  );
}
