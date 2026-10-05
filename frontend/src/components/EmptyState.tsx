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
        <h2 className="text-2xl font-semibold tracking-tight">{t('emptyTitle')}</h2>
        <p className="mt-2 text-ink-muted">{t('emptyBody')}</p>
      </div>

      <div
        data-testid="dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-12 text-center ${
          dragging ? 'border-accent bg-bg-hover' : 'border-border-strong bg-bg-panel'
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

      <div className="space-y-1 text-sm text-ink-muted">
        <p>{t('privacyNote')}</p>
        <p>{t('scopeNote')}</p>
      </div>
    </div>
  );
}
