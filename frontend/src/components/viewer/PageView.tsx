import { useEffect, useMemo, useRef } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { GeometryPage } from '../../engine/types';
import { GeometryOverlay, type GuideVisibility } from './GeometryOverlay';
import type { ViewerMark } from './types';

interface Props {
  proxy: PDFPageProxy;
  scale: number;
  geometry: GeometryPage | null;
  guides: GuideVisibility;
  marks: ViewerMark[];
  activeMarkId: string | null;
  onRenderError: (message: string) => void;
}

/** One rendered PDF page: canvas (PDF.js) + SVG overlay on the same viewport. */
export function PageView({ proxy, scale, geometry, guides, marks, activeMarkId, onRenderError }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewport = useMemo(() => proxy.getViewport({ scale }), [proxy, scale]);

  useEffect(() => {
    const vp = viewport;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const task = proxy.render({
      canvasContext: ctx,
      canvas,
      viewport: vp,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
    });
    task.promise.catch((err: unknown) => {
      if (err instanceof Error && err.name === 'RenderingCancelledException') return;
      onRenderError(err instanceof Error ? err.message : String(err));
    });
    return () => task.cancel();
  }, [proxy, viewport, onRenderError]);

  return (
    <>
      <canvas ref={canvasRef} className="block h-full w-full bg-white" />
      <GeometryOverlay viewport={viewport} geometry={geometry} guides={guides} marks={marks} activeMarkId={activeMarkId} />
    </>
  );
}
