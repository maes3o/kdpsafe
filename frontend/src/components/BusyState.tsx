import { Mark } from './icons';

/** Honest indeterminate progress: a spinning ring around the KDPSafe mark.
 * No fake percentages or fake steps. */
export function BusyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-bg p-6 text-center shadow-card">
      <span className="relative inline-flex h-20 w-20 items-center justify-center text-ink" aria-hidden="true">
        <span className="absolute inset-0 rounded-full border-4 border-accent-soft" />
        <span className="spin-ring absolute inset-0 rounded-full border-4 border-transparent border-t-accent" />
        <Mark size={36} />
      </span>
      <p className="text-base font-semibold">{title}</p>
      {detail && <p className="text-sm text-ink-muted">{detail}</p>}
    </div>
  );
}
