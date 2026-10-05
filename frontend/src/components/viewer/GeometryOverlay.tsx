import type { PageViewport } from 'pdfjs-dist';
import type { BBoxPt, GeometryPage, PartialHorizontalBBoxPt } from '../../engine/types';
import type { ViewerMark } from './types';

export interface GuideVisibility {
  trim: boolean;
  bleed: boolean;
  safe: boolean;
}

interface Props {
  viewport: PageViewport;
  geometry: GeometryPage | null;
  guides: GuideVisibility;
  marks: ViewerMark[];
  activeMarkId: string | null;
}

interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** PDF user-space box -> viewport pixels, via PDF.js's own transform so zoom,
 * page offset and rotation are all handled by the same code that rendered
 * the page. */
function toPx(viewport: PageViewport, minX: number, minY: number, maxX: number, maxY: number): PxRect {
  const [x1, y1] = viewport.convertToViewportPoint(minX, minY) as [number, number];
  const [x2, y2] = viewport.convertToViewportPoint(maxX, maxY) as [number, number];
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

const GLYPH: Record<ViewerMark['kind'], string> = { problem: '×', review: '?', fixed: '✓' };

/** Guide line style differs per guide (not colour alone): trim solid, bleed
 * long-dash, safe margin dotted. */
const GUIDE_STYLE = {
  trim: { cls: 'guide-trim', dash: undefined },
  bleed: { cls: 'guide-bleed', dash: '10 5' },
  safe: { cls: 'guide-safe', dash: '2 4' },
} as const;

type GuideKey = keyof typeof GUIDE_STYLE;

function GuideShape({
  kind,
  box,
  trim,
  viewport,
}: {
  kind: GuideKey;
  box: BBoxPt | PartialHorizontalBBoxPt;
  trim: BBoxPt | null;
  viewport: PageViewport;
}) {
  const style = GUIDE_STYLE[kind];
  const common = {
    className: style.cls,
    fill: 'none',
    strokeWidth: 1.5,
    strokeDasharray: style.dash,
    vectorEffect: 'non-scaling-stroke' as const,
  };
  if (box.minX !== null && box.maxX !== null) {
    const r = toPx(viewport, box.minX, box.minY, box.maxX, box.maxY);
    return <rect x={r.x} y={r.y} width={r.w} height={r.h} {...common} />;
  }
  // Horizontal extent is genuinely unknown (engine: null). Draw only what
  // is known -- the top and bottom edges -- across the trim width; no fake
  // left/right guides.
  if (!trim) return null;
  const top = toPx(viewport, trim.minX, box.maxY, trim.maxX, box.maxY);
  const bottom = toPx(viewport, trim.minX, box.minY, trim.maxX, box.minY);
  return (
    <>
      <line x1={top.x} y1={top.y} x2={top.x + top.w} y2={top.y} {...common} />
      <line x1={bottom.x} y1={bottom.y} x2={bottom.x + bottom.w} y2={bottom.y} {...common} />
    </>
  );
}

/** SVG layer stacked on a rendered page. Everything drawn comes from the
 * engine result (geometry + marks) -- no hardcoded coordinates. */
export function GeometryOverlay({ viewport, geometry, guides, marks, activeMarkId }: Props) {
  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={viewport.width}
      height={viewport.height}
      viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      aria-hidden="true"
    >
      {geometry?.bleedBox && guides.bleed && (
        <GuideShape kind="bleed" box={geometry.bleedBox} trim={geometry.trimBox} viewport={viewport} />
      )}
      {geometry?.trimBox && guides.trim && (
        <GuideShape kind="trim" box={geometry.trimBox} trim={geometry.trimBox} viewport={viewport} />
      )}
      {geometry?.safeZone && guides.safe && (
        <GuideShape kind="safe" box={geometry.safeZone} trim={geometry.trimBox} viewport={viewport} />
      )}
      {marks.map((m) => {
        const r = toPx(viewport, m.bbox.minX, m.bbox.minY, m.bbox.maxX, m.bbox.maxY);
        const active = m.id === activeMarkId;
        return (
          <g key={m.id} className={`mark-${m.kind}`}>
            <rect
              x={r.x}
              y={r.y}
              width={Math.max(r.w, 2)}
              height={Math.max(r.h, 2)}
              strokeWidth={active ? 3 : 1.5}
              strokeDasharray={m.kind === 'review' ? '5 3' : undefined}
              className="mark-box"
              fillOpacity={active ? 0.22 : 0.08}
              vectorEffect="non-scaling-stroke"
            />
            <text x={r.x + 3} y={Math.max(r.y - 4, 12)} className="mark-glyph" fontSize={14} fontWeight={700}>
              {GLYPH[m.kind]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
