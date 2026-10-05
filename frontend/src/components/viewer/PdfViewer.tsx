import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
// Legacy build: same one the engine uses; runs on browsers without the newest JS APIs.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
// Vite `?url` gives the bundled URL of pdf.js's own parsing worker (separate
// from our preflight worker); it only serves on-screen rendering.
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { useI18n } from '../../i18n/context';
import type { InspectionResult } from '../../engine/types';
import type { DocInfo } from '../../workspace/useWorkspace';
import { PageView } from './PageView';
import type { GuideVisibility } from './GeometryOverlay';
import type { ViewerFocus, ViewerMark } from './types';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const GAP = 12;
const PAD = 16;
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
/** Fit-to-width never blows a small page up beyond this. */
const MAX_FIT_SCALE = 1.75;

interface PageMeta {
  proxy: PDFPageProxy;
  /** Page size in points at scale 1 (rotation applied). */
  width: number;
  height: number;
}

interface Props {
  pdfBytes: Uint8Array | null;
  /** Engine result describing THESE bytes (source of the guides). */
  inspection: InspectionResult | null;
  marks: ViewerMark[];
  activeMarkId: string | null;
  focus: ViewerFocus | null;
  onDocumentInfo?: (info: DocInfo) => void;
  /** Extra controls (e.g. original/fixed toggle) shown in the toolbar. */
  toolbarExtra?: ReactNode;
}

type Zoom = { mode: 'fit' } | { mode: 'manual'; scale: number };

export function PdfViewer({ pdfBytes, inspection, marks, activeMarkId, focus, onDocumentInfo, toolbarExtra }: Props) {
  const { t, formatNumber } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<PageMeta[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>({ mode: 'fit' });
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollState, setScrollState] = useState({ top: 0, height: 0 });
  const [currentPage, setCurrentPage] = useState(0);
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const [guides, setGuides] = useState<GuideVisibility>({ trim: true, bleed: true, safe: true });
  const infoCb = useRef(onDocumentInfo);
  infoCb.current = onDocumentInfo;

  // ---- load document -------------------------------------------------
  useEffect(() => {
    setPages(null);
    setLoadError(null);
    setRenderError(null);
    if (!pdfBytes) return;
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    (async () => {
      try {
        // pdf.js transfers/detaches the buffer it's given -- hand it a copy.
        task = pdfjsLib.getDocument({ data: pdfBytes.slice() });
        const doc: PDFDocumentProxy = await task.promise;
        const metas: PageMeta[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const proxy = await doc.getPage(i);
          if (cancelled) return;
          const vp = proxy.getViewport({ scale: 1 });
          metas.push({ proxy, width: vp.width, height: vp.height });
        }
        if (cancelled) return;
        setPages(metas);
        setCurrentPage(0);
        const first = metas[0];
        if (first) {
          infoCb.current?.({
            pageCount: metas.length,
            firstPageWidthIn: first.width / 72,
            firstPageHeightIn: first.height / 72,
          });
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [pdfBytes]);

  // ---- container size / scroll tracking ------------------------------
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setContainerWidth(el.clientWidth);
      setScrollState({ top: el.scrollTop, height: el.clientHeight });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pages]);

  const maxPageWidth = useMemo(() => (pages ? Math.max(...pages.map((p) => p.width)) : 1), [pages]);
  const fitScale = containerWidth > 0 ? Math.min(MAX_FIT_SCALE, Math.max(MIN_SCALE, (containerWidth - PAD * 2) / maxPageWidth)) : 1;
  const scale = zoom.mode === 'fit' ? fitScale : zoom.scale;

  const layout = useMemo(() => {
    if (!pages) return { tops: [] as number[], heights: [] as number[], total: 0 };
    const tops: number[] = [];
    const heights: number[] = [];
    let y = PAD;
    for (const p of pages) {
      tops.push(y);
      const h = p.height * scale;
      heights.push(h);
      y += h + GAP;
    }
    return { tops, heights, total: y - GAP + PAD };
  }, [pages, scale]);

  const pageAtScroll = useCallback(
    (top: number, height: number) => {
      const probe = top + height / 3;
      let lo = 0;
      let hi = layout.tops.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (layout.tops[mid] <= probe) lo = mid;
        else hi = mid - 1;
      }
      return Math.max(0, lo);
    },
    [layout]
  );

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollState({ top: el.scrollTop, height: el.clientHeight });
    setCurrentPage(pageAtScroll(el.scrollTop, el.clientHeight));
  }, [pageAtScroll]);

  // Keep the current page anchored when zoom/fit changes the layout.
  const anchorPage = useRef(0);
  anchorPage.current = currentPage;
  const prevScale = useRef(scale);
  useLayoutEffect(() => {
    if (prevScale.current === scale) return;
    prevScale.current = scale;
    const el = scrollRef.current;
    if (el && layout.tops[anchorPage.current] !== undefined) {
      el.scrollTop = Math.max(0, layout.tops[anchorPage.current] - GAP);
      setScrollState({ top: el.scrollTop, height: el.clientHeight });
    }
  }, [scale, layout]);

  const goToPage = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      if (!el || !pages) return;
      const i = Math.min(Math.max(index, 0), pages.length - 1);
      el.scrollTop = Math.max(0, layout.tops[i] - GAP);
      setScrollState({ top: el.scrollTop, height: el.clientHeight });
      setCurrentPage(i);
    },
    [layout, pages]
  );

  // ---- issue -> page (and bbox) navigation ---------------------------
  const lastFocus = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || !pages || lastFocus.current === focus.nonce) return;
    const meta = pages[focus.pageIndex];
    const el = scrollRef.current;
    if (!meta || !el) return;
    lastFocus.current = focus.nonce;
    let target = layout.tops[focus.pageIndex] - GAP;
    if (focus.bbox) {
      // Same PDF.js transform that draws the overlay.
      const vp = meta.proxy.getViewport({ scale });
      const [, y1] = vp.convertToViewportPoint(focus.bbox.minX, focus.bbox.minY) as [number, number];
      const [, y2] = vp.convertToViewportPoint(focus.bbox.maxX, focus.bbox.maxY) as [number, number];
      target = layout.tops[focus.pageIndex] + Math.min(y1, y2) - el.clientHeight / 3;
    }
    el.scrollTop = Math.max(0, target);
    setScrollState({ top: el.scrollTop, height: el.clientHeight });
    setCurrentPage(focus.pageIndex);
  }, [focus, pages, layout, scale]);

  const onRenderError = useCallback((m: string) => setRenderError(m), []);

  // ---- zoom ----------------------------------------------------------
  const zoomBy = (factor: number) =>
    setZoom({ mode: 'manual', scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor)) });

  const total = pages?.length ?? 0;
  const marksByPage = useMemo(() => {
    const map = new Map<number, ViewerMark[]>();
    for (const m of marks) {
      const list = map.get(m.pageIndex);
      if (list) list.push(m);
      else map.set(m.pageIndex, [m]);
    }
    return map;
  }, [marks]);

  const visibleFrom = scrollState.top - scrollState.height;
  const visibleTo = scrollState.top + scrollState.height * 2;
  const geometryByPage = inspection?.geometry.pages;

  const submitPageDraft = () => {
    const n = Number(pageDraft);
    if (pageDraft !== null && Number.isInteger(n) && n >= 1 && n <= total) goToPage(n - 1);
    setPageDraft(null);
  };

  const btn =
    'inline-flex h-8 min-w-8 items-center justify-center rounded border border-border bg-bg px-2 text-sm text-ink hover:bg-bg-hover disabled:opacity-40 disabled:hover:bg-bg';

  return (
    <section className="flex h-full min-h-0 flex-col bg-viewer" aria-label="PDF">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-panel px-3 py-2">
        <div className="flex items-center gap-1" role="group" aria-label={t('viewerPageInput')}>
          <button type="button" className={btn} onClick={() => goToPage(currentPage - 1)} disabled={!pages || currentPage <= 0} aria-label={t('viewerPrev')} title={t('viewerPrev')}>
            ‹
          </button>
          <input
            aria-label={t('viewerPageInput')}
            className="h-8 w-14 rounded border border-border bg-bg px-1 text-center font-mono text-sm"
            inputMode="numeric"
            value={pageDraft ?? (pages ? String(currentPage + 1) : '')}
            disabled={!pages}
            onChange={(e) => setPageDraft(e.target.value)}
            onBlur={submitPageDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPageDraft();
              if (e.key === 'Escape') setPageDraft(null);
            }}
          />
          <span className="font-mono text-sm text-ink-muted" aria-live="polite">
            / {total || '–'}
          </span>
          <button type="button" className={btn} onClick={() => goToPage(currentPage + 1)} disabled={!pages || currentPage >= total - 1} aria-label={t('viewerNext')} title={t('viewerNext')}>
            ›
          </button>
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Zoom">
          <button type="button" className={btn} onClick={() => zoomBy(1 / 1.25)} disabled={!pages} aria-label={t('viewerZoomOut')} title={t('viewerZoomOut')}>
            −
          </button>
          <span className="w-12 text-center font-mono text-sm text-ink-muted">{pages ? `${formatNumber(Math.round(scale * 100), 0)}%` : '–'}</span>
          <button type="button" className={btn} onClick={() => zoomBy(1.25)} disabled={!pages} aria-label={t('viewerZoomIn')} title={t('viewerZoomIn')}>
            +
          </button>
          <button type="button" className={btn} onClick={() => setZoom({ mode: 'fit' })} disabled={!pages} aria-pressed={zoom.mode === 'fit'}>
            {t('viewerFitWidth')}
          </button>
        </div>

        {geometryByPage && (
          <fieldset className="flex items-center gap-3 text-xs text-ink-muted">
            <legend className="sr-only">{t('overlayGuides')}</legend>
            {(['trim', 'bleed', 'safe'] as const).map((k) => (
              <label key={k} className="inline-flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={guides[k]}
                  onChange={(e) => setGuides((g) => ({ ...g, [k]: e.target.checked }))}
                  className="accent-accent"
                />
                <svg width="22" height="8" aria-hidden="true">
                  <line
                    x1="0"
                    y1="4"
                    x2="22"
                    y2="4"
                    strokeWidth="2"
                    strokeDasharray={k === 'bleed' ? '6 3' : k === 'safe' ? '2 3' : undefined}
                    className={k === 'trim' ? 'guide-trim' : k === 'bleed' ? 'guide-bleed' : 'guide-safe'}
                  />
                </svg>
                {t(k === 'trim' ? 'overlayTrim' : k === 'bleed' ? 'overlayBleed' : 'overlaySafe')}
              </label>
            ))}
          </fieldset>
        )}

        {toolbarExtra && <div className="ml-auto">{toolbarExtra}</div>}
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto" data-testid="viewer-scroll" tabIndex={0} aria-label="PDF pages">
        {!pdfBytes && <p className="p-6 text-sm text-ink-muted">{t('viewerNoDocument')}</p>}
        {pdfBytes && !pages && !loadError && <p className="p-6 text-sm text-ink-muted">{t('viewerLoading')}</p>}
        {(loadError || renderError) && (
          <div role="alert" className="m-4 rounded border border-status-error bg-status-error-soft p-3 text-sm text-ink">
            <p className="font-medium">
              <span aria-hidden="true">× </span>
              {t('viewerError')}
            </p>
            <p className="mt-1 font-mono text-xs text-ink-muted">{loadError ?? renderError}</p>
          </div>
        )}
        {pages && (
          <div className="relative mx-auto" style={{ height: layout.total, width: Math.max(maxPageWidth * scale + PAD * 2, containerWidth) }}>
            {pages.map((meta, i) => {
              const top = layout.tops[i];
              const h = layout.heights[i];
              const w = meta.width * scale;
              const near = top + h >= visibleFrom && top <= visibleTo;
              const geometry = geometryByPage?.find((g) => g.pageIndex === i) ?? null;
              return (
                <div
                  key={i}
                  data-page={i + 1}
                  className="absolute left-1/2 -translate-x-1/2 shadow-page"
                  style={{ top, width: w, height: h }}
                >
                  {near && (
                    <PageView
                      proxy={meta.proxy}
                      scale={scale}
                      geometry={geometry}
                      guides={guides}
                      marks={marksByPage.get(i) ?? []}
                      activeMarkId={activeMarkId}
                      onRenderError={onRenderError}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {geometryByPage && pages && geometryByPage[currentPage]?.status === 'unavailable' && (
        <p className="border-t border-border bg-bg-panel px-3 py-1.5 text-xs text-ink-muted">{t('overlayUnavailable')}</p>
      )}
    </section>
  );
}
