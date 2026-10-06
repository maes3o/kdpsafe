/** Small inline icons (decorative: always paired with text or an aria-label). */
import type { ReactNode } from 'react';

function Svg({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const IconUpload = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
  </Svg>
);
export const IconDownload = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 4v12M7 11l5 5 5-5M4 20h16" />
  </Svg>
);
export const IconClose = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const IconArrow = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const IconArrowDown = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
);
export const IconSparkle = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
  </Svg>
);
export const IconSun = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);
export const IconMoon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
  </Svg>
);
export const IconCheckDoc = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 14l2 2 4-4" />
  </Svg>
);
export const IconWand = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 20L16 8M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 12l.7 1.3L21 14l-1.3.7L19 16l-.7-1.3L17 14l1.3-.7z" />
  </Svg>
);

/** Red "PDF" file badge. */
export function PdfBadge() {
  return (
    <span aria-hidden="true" className="inline-flex h-10 w-9 shrink-0 items-end justify-center rounded-md bg-status-error-soft pb-1 font-mono text-[9px] font-bold text-status-error ring-1 ring-status-error/30">
      PDF
    </span>
  );
}

/**
 * The KDPSafe mark: crop-mark brackets (the page edge) around a page with a
 * folded corner (the PDF / safe area). Brackets follow the text colour; the
 * page is brand violet. Works standalone from 16 px up.
 */
export function Mark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <g fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 11V8a3 3 0 0 1 3-3h3" />
        <path d="M21 5h3a3 3 0 0 1 3 3v3" />
        <path d="M27 21v3a3 3 0 0 1-3 3h-3" />
        <path d="M11 27H8a3 3 0 0 1-3-3v-3" />
      </g>
      <path d="M10.5 9.5h7l4 4v9h-11z" className="fill-accent" />
      <path d="M17.5 9.5v4h4" fill="none" className="stroke-bg" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export const IconBack = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);
