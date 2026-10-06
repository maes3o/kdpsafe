import { useCallback, useRef, useState } from 'react';
import { PreflightClient } from './engine/client';
import type { InspectionResult, UserIntent } from './engine/types';
import { useI18n } from './i18n/context';
import { useTheme } from './theme/context';
import { UploadDropzone } from './components/UploadDropzone';
import { VerdictBanner } from './components/VerdictBanner';
import { PdfViewer } from './components/PdfViewer';
import { SmartFixPanel } from './components/SmartFixPanel';
import type { Locale } from './i18n/strings';

type AppState =
  | { phase: 'empty' }
  | { phase: 'processing' }
  | { phase: 'result'; result: InspectionResult }
  | { phase: 'error'; message: string };

// FRONTEND-01 shell default: no bleed, no reading-direction decided yet.
// A real trim-size picker and the LEM_ORIENTATION_AMBIGUOUS ->
// readingDirection prompt are future UI work, not invented here. Shared
// by both the read-only preflight call and Smart Fix so the two always
// agree on what "the required size" means.
const DEFAULT_USER_INTENT: UserIntent = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false };

/**
 * Single Document Workspace shell (FRONTEND-01 scope). This is the minimal
 * skeleton that validates the architecture end to end: real file -> real
 * Web Worker -> real runPreflight() -> real result rendered. It covers
 * states 1 (empty), 2 (processing), 3/4/5 (READY / NEEDS_ATTENTION /
 * MANUAL_REVIEW_REQUIRED, via VerdictBanner + the raw violations/manual
 * review lists) and 9 (error). States 6/7/8 (autofix preview / apply /
 * re-verify) are deliberately NOT built here -- they depend on
 * verifyAutofix()'s apply path, which is not wired into the worker this
 * checkpoint (see preflight.worker.ts). Visual polish is also deliberately
 * deferred; this is a structural shell, not the finished design.
 */
function App() {
  const { t, locale, setLocale } = useI18n();
  const { mode, toggle } = useTheme();
  const [state, setState] = useState<AppState>({ phase: 'empty' });
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const clientRef = useRef<PreflightClient | null>(null);

  function getClient(): PreflightClient {
    if (!clientRef.current) clientRef.current = new PreflightClient();
    return clientRef.current;
  }

  const handleFile = useCallback(async (file: File) => {
    setState({ phase: 'processing' });
    try {
      const buf = await file.arrayBuffer();
      // Keep our own copy for the viewer -- the worker call below
      // transfers (detaches) the ArrayBuffer it's given.
      setPdfBytes(new Uint8Array(buf.slice(0)));
      const result = await getClient().runPreflight(buf, { userIntent: DEFAULT_USER_INTENT });
      setState({ phase: 'result', result });
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  return (
    <div className="flex h-screen flex-col bg-bg text-ink">
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <h1 className="font-mono text-sm font-semibold tracking-wide">{t('appTitle')}</h1>
        <div className="flex items-center gap-3 text-xs">
          <select
            aria-label="Language"
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            className="rounded border border-border bg-bg-panel px-1.5 py-1 text-ink"
          >
            <option value="en">EN</option>
            <option value="uk">UA</option>
          </select>
          <button
            type="button"
            onClick={toggle}
            className="rounded border border-border px-2 py-1 text-ink hover:border-border-strong"
          >
            {mode === 'light' ? t('themeDark') : t('themeLight')}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-[400px] shrink-0 overflow-y-auto border-r border-border bg-bg-panel p-4">
          <ResultPanel state={state} onFile={handleFile} pdfBytes={pdfBytes} />
        </aside>
        <main className="flex-1 overflow-auto p-6">
          <PdfViewer pdfBytes={pdfBytes} />
        </main>
      </div>
    </div>
  );
}

function ResultPanel({
  state,
  onFile,
  pdfBytes,
}: {
  state: AppState;
  onFile: (file: File) => void;
  pdfBytes: Uint8Array | null;
}) {
  const { t } = useI18n();

  if (state.phase === 'empty') {
    return <UploadDropzone onFile={onFile} />;
  }

  if (state.phase === 'processing') {
    return <p className="text-sm text-ink-muted">{t('processing')}</p>;
  }

  if (state.phase === 'error') {
    return (
      <div>
        <span className="font-medium text-status-error">× {t('verdictError')}</span>
        <p className="mt-2 text-sm text-ink-muted">{state.message}</p>
      </div>
    );
  }

  const { result } = state;
  const { violations, categories } = result;
  const manualReview = categories.margins.manualReview;

  return (
    <div className="flex flex-col gap-4">
      <VerdictBanner verdict={result.verdict} />

      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
          {t('violationsHeading')}
        </h2>
        {violations.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('noIssues')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {violations.map((v, i) => (
              <li key={i} className="rounded border border-border px-2.5 py-1.5 text-sm">
                <span className="font-mono text-xs text-ink-muted">
                  {t('pageOf', { current: v.pageIndex + 1, total: result.document.pageCount })}
                </span>
                {' · '}
                {v.violation} · {v.side} · {v.amountPt.toFixed(1)}pt
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
          {t('manualReviewHeading')}
        </h2>
        {manualReview.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('noIssues')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {manualReview.map((m, i) => (
              <li key={i} className="rounded border border-border px-2.5 py-1.5 text-sm">
                <span className="font-mono text-xs text-ink-muted">
                  {t('pageOf', { current: m.pageIndex + 1, total: result.document.pageCount })}
                </span>
                {' · '}
                {m.reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      <SmartFixPanel pdfBytes={pdfBytes} userIntent={DEFAULT_USER_INTENT} />
    </div>
  );
}

export default App;
