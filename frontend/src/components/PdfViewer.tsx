import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// Vite's `?url` suffix returns the bundled asset URL for pdfjs's worker
// script -- the standard Vite+pdfjs-dist integration pattern. This runs
// pdf.js's OWN internal parsing worker (separate from our preflight
// worker), purely for on-screen rendering.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Renders page 1 of the given PDF bytes to a canvas, with an empty SVG
 * layer stacked exactly on top at the same pixel size. FRONTEND-01 scope:
 * the overlay is a structural placeholder only -- actual Trim/Bleed/LEM
 * guide drawing (from InspectionResult.geometry) is deliberately deferred
 * to a future checkpoint, not drawn here yet.
 */
export function PdfViewer({ pdfBytes }: { pdfBytes: Uint8Array | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pdfBytes) return;
    let cancelled = false;

    (async () => {
      try {
        // pdfjs detaches/transfers the buffer it's given (same quirk
        // lib/margin.js's analyzePageObjects() already works around on the
        // engine side) -- slice so the caller's own copy is never affected.
        const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1.5 });
        if (cancelled) return;
        setSize({ width: viewport.width, height: viewport.height });

        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfBytes]);

  if (!pdfBytes) return null;
  if (error) return <p className="text-sm text-status-error">{error}</p>;

  return (
    <div className="relative inline-block" style={size ? { width: size.width, height: size.height } : undefined}>
      <canvas ref={canvasRef} className="block shadow-sm" />
      {/* Structural placeholder for the future Trim/Bleed/LEM geometry
          overlay -- intentionally empty in this checkpoint. */}
      <svg
        className="pointer-events-none absolute inset-0"
        width={size?.width ?? 0}
        height={size?.height ?? 0}
        aria-hidden="true"
      />
    </div>
  );
}
