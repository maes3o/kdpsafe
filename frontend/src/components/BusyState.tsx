/** Honest indeterminate state (no fake percentages). */
export function BusyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div role="status" aria-live="polite" className="rounded-lg border border-border bg-bg-panel p-4">
      <p className="font-medium">{title}</p>
      {detail && <p className="mt-1 text-sm text-ink-muted">{detail}</p>}
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded bg-bg-hover" aria-hidden="true">
        <div className="indeterminate-bar h-full w-1/3 rounded bg-accent" />
      </div>
    </div>
  );
}
