import { useRef, type DragEvent } from 'react';
import { useI18n } from '../i18n/context';

export function UploadDropzone({ onFile }: { onFile: (file: File) => void }) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      className="flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border px-6 py-10 text-center cursor-pointer hover:border-border-strong"
    >
      <p className="text-sm font-medium text-ink">{t('uploadPrompt')}</p>
      <p className="text-xs text-ink-muted">{t('uploadHint')}</p>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
        }}
      />
    </div>
  );
}
