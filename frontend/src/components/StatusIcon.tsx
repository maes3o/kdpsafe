import { GLYPH, TONE, type Tone } from './ui';

/** Glyph + text label. The glyph and the text carry the state; colour only
 * reinforces it (NEVER colour alone). */
export function StatusIcon({ tone, label, className = '' }: { tone: Tone; label: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${TONE[tone].text} ${className}`}>
      <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-current font-mono text-xs leading-none">
        {GLYPH[tone]}
      </span>
      <span>{label}</span>
    </span>
  );
}
