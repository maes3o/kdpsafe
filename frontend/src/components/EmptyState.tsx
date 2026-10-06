import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useI18n } from '../i18n/context';
import { IconArrow, IconCheckDoc, IconUpload, IconWand } from './icons';
import { btnPrimary } from './ui';

/** Decorative: a tilted PDF page with a check badge and corner marks. */
function Hero() {
  return (
    <div className="hero-glow relative mx-auto flex h-64 w-full max-w-sm items-center justify-center" aria-hidden="true">
      {['left-6 top-6', 'right-6 top-6', 'left-6 bottom-6', 'right-6 bottom-6'].map((pos) => (
        <span key={pos} className={`absolute ${pos} text-xl font-light text-accent/70`}>
          +
        </span>
      ))}
      <div className="relative -rotate-6 rounded-2xl border border-border bg-bg p-5 shadow-card">
        <div className="flex h-36 w-28 flex-col items-center justify-center rounded-lg border border-border bg-bg-panel">
          <span className="text-2xl font-extrabold tracking-tight text-accent">PDF</span>
          <span className="mt-1 text-[10px] text-ink-muted">KDP</span>
        </div>
        <span className="absolute -bottom-3 -right-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-accent text-lg font-bold text-accent-ink shadow-card ring-4 ring-bg">
          ✓
        </span>
      </div>
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
