import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useI18n } from '../i18n/context';
import { IconArrow, IconCheckDoc, IconUpload, IconWand } from './icons';
import { btnPrimary } from './ui';

/** Decorative: a PDF page with a folded corner and a dashed safe area, held
 * by crop-mark brackets (the KDPSafe mark, scaled up). */
function Hero() {
  return (
    <div className="hero-glow relative mx-auto flex h-72 w-full max-w-sm items-center justify-center text-ink-muted" aria-hidden="true">
      <svg viewBox="0 0 240 280" className="h-full w-auto">
        <g transform="rotate(-5 120 140)">
          <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.7">
            <path d="M24 70V40a14 14 0 0 1 14-14h30" />
            <path d="M172 26h30a14 14 0 0 1 14 14v30" />
            <path d="M216 210v30a14 14 0 0 1-14 14h-30" />
            <path d="M68 254H38a14 14 0 0 1-14-14v-30" />
          </g>
          <path d="M56 52h86l42 42v134H56z" className="fill-bg stroke-border-strong" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M142 52v42h42" className="fill-accent-soft stroke-border-strong" strokeWidth="1.5" strokeLinejoin="round" />
          <rect x="72" y="112" width="96" height="100" rx="3" fill="none" className="stroke-accent" strokeWidth="1.6" strokeDasharray="4 5" />
          <text x="120" y="170" textAnchor="middle" className="fill-accent" fontSize="30" fontWeight="800" fontFamily="Inter Variable, Inter, sans-serif">
            PDF
          </text>
        </g>
        <circle cx="178" cy="226" r="19" className="fill-accent stroke-bg" strokeWidth="4" />
        <path d="M169 226l6 6 11-12" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Step({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <li className="flex flex-col items-center gap-2 text-center text-xs font-medium">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">{icon}</span>
      <span>{label}</span>
    </li>
  );
}

/** Landing: value proposition, accessible dropzone (works without drag and
 * drop via the button), the three-step flow, privacy and scope. */
export function EmptyState({ onFile, notice }: { onFile: (file: File) => void; notice?: string | null }) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  }

  return (
    <div
      data-testid="dropzone"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className="mx-auto grid w-full max-w-5xl items-center gap-8 px-5 py-8 md:grid-cols-2 md:py-14"
    >
      <div className="space-y-5">
        <h2 className="text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{t('emptyTitle')}</h2>
        <p className="text-ink-muted">{t('emptyBody')}</p>
        <div className="md:hidden">
          <Hero />
        </div>
        <div className="space-y-2">
          <button type="button" className={`${btnPrimary} w-full py-3.5 text-base md:w-auto md:px-8 ${dragging ? 'ring-4 ring-accent/30' : ''}`} onClick={() => inputRef.current?.click()}>
            <IconUpload />
            {t('browse')}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            tabIndex={-1}
            aria-label={t('browse')}
            data-testid="file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFile(file);
              e.target.value = '';
            }}
          />
          <p className="text-center text-sm text-ink-muted md:text-left">{t('dropOrDrag')}</p>
          <p className="text-center text-xs text-ink-muted md:text-left">{t('dropHint')}</p>
        </div>

        {notice && (
          <p role="alert" className="rounded-xl border border-status-error bg-status-error-soft px-3 py-2 text-sm">
            <span aria-hidden="true" className="mr-1 font-mono">×</span>
            {notice}
          </p>
        )}

        <ol className="flex items-start justify-between gap-2 pt-2" aria-label="1 → 2 → 3">
          <Step icon={<IconUpload />} label={t('stepA')} />
          <li aria-hidden="true" className="mt-3 text-border-strong"><IconArrow /></li>
          <Step icon={<IconCheckDoc />} label={t('stepB')} />
          <li aria-hidden="true" className="mt-3 text-border-strong"><IconArrow /></li>
          <Step icon={<IconWand />} label={t('stepC')} />
        </ol>

        <div className="space-y-1 text-xs text-ink-muted">
          <p>{t('privacyNote')}</p>
          <p>{t('scopeNote')}</p>
        </div>
      </div>
      <div className="hidden md:block">
        <Hero />
      </div>
    </div>
  );
}
