import { useRef, useState, type DragEvent } from 'react';
import { useI18n } from '../i18n/context';
import { btnPrimary } from './ui';

/** Empty state: value proposition + accessible PDF dropzone (works without
 * drag and drop via the Browse button / keyboard). */
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
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col justify-center gap-6 px-4 py-10">
      <div>
        <h2 className="font-display text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{t('emptyTitle')}</h2>
        <p className="mt-3 text-ink-muted">{t('emptyBody')}</p>
      </div>

      <div
        data-testid="dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`crop-marks mx-2.5 flex flex-col items-center gap-3 border border-border px-6 py-12 text-center ${
          dragging ? 'bg-bg-hover' : 'bg-bg-panel'
        }`}
      >
        <p className="text-base font-medium">{t('dropPrompt')}</p>
        <p className="text-sm text-ink-muted">{t('dropOr')}</p>
        <button type="button" className={btnPrimary} onClick={() => inputRef.current?.click()}>
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
        <p className="text-xs text-ink-muted">{t('dropHint')}</p>
      </div>

      {notice && (
        <p role="alert" className="rounded-md border border-status-error bg-status-error-soft px-3 py-2 text-sm">
          <span aria-hidden="true" className="mr-1 font-mono">×</span>
          {notice}
        </p>
      )}

      <ol className="grid gap-3 text-sm sm:grid-cols-3">
        {(['step1', 'step2', 'step3'] as const).map((k, i) => (
          <li key={k} className="flex gap-2">
            <span className="font-mono text-ink-muted">{i + 1}</span>
            <span>{t(k)}</span>
          </li>
        ))}
      </ol>

      <div className="space-y-1 text-xs text-ink-muted">
        <p>{t('privacyNote')}</p>
        <p>{t('scopeNote')}</p>
      </div>
    </div>
  );
}
