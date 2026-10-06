import { useI18n } from '../i18n/context';
import type { BBoxPt, InspectionResult, ManualReviewEntry, Violation } from '../engine/types';
import { formatPoints, objectLabel, sideLabel, sidesLabel } from '../i18n/labels';
import { useUnit } from '../units/context';
import type { StringKey } from '../i18n/strings';
import { groupByPage, isAmbiguous, manualId, violationId } from '../workspace/issues';
import { StatusIcon } from './StatusIcon';
import { sectionTitle } from './ui';

const MANUAL_TEXT: Record<ManualReviewEntry['reason'], StringKey> = {
  LEM_ORIENTATION_AMBIGUOUS: 'mrAmbiguous',
  BLEED_VIOLATION: 'mrBleed',
  TEXT_LEM_VIOLATION: 'mrText',
  LEM_VIOLATION_OVER_AUTOFIX_THRESHOLD: 'mrOverThreshold',
  HORIZONTAL_GEOMETRY_UNRESOLVED: 'mrUnresolved',
};

export type FocusIssue = (id: string, pageIndex: number, bbox?: BBoxPt) => void;

interface Props {
  inspection: InspectionResult;
  afterFix: boolean;
  activeId: string | null;
  onFocus: FocusIssue;
}

function PageGroup({ page, count, defaultOpen, children }: { page: number; count: number; defaultOpen: boolean; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <details open={defaultOpen} className="rounded-md border border-border">
      <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm font-medium">
        <span>{t('pageNumber', { page })}</span>
        <span className="text-xs font-normal text-ink-muted">{t('pageGroupCount', { n: count })}</span>
      </summary>
      <ul className="divide-y divide-border border-t border-border">{children}</ul>
    </details>
  );
}

function RowButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'true' : undefined}
        className={`block w-full px-3 py-2.5 text-left hover:bg-bg-hover ${active ? 'bg-bg-hover' : ''}`}
      >
        {children}
        <span className="mt-1 block text-xs font-medium underline underline-offset-2">{t("showInPdf")} →</span>
      </button>
    </li>
  );
}

function ViolationRow({ v, id, active, onFocus }: { v: Violation; id: string; active: boolean; onFocus: FocusIssue }) {
  const { t, formatNumber } = useI18n();
  const { formatPt } = useUnit();
  const amount = formatPt(v.amountPt);
  const text = t(v.violation === 'LEM' ? 'issueLem' : 'issueBleed', {
    object: objectLabel(t, v.type),
    amount,
    side: sideLabel(t, v.side),
  });
  return (
    <RowButton active={active} onClick={() => onFocus(id, v.pageIndex, v.visibleBBoxPt)}>
      <StatusIcon tone={v.severity === 'error' ? 'error' : 'attention'} label={v.severity === 'error' ? t('severityError') : t('severityWarning')} className="text-sm" />
      <span className="mt-1 block text-sm">{text}</span>
      <span className="mt-0.5 block font-mono text-xs text-ink-muted">
        {v.violation} · {v.side} · {amount} · {formatPoints(v.amountPt, formatNumber, t('pointsShort'))}
      </span>
    </RowButton>
  );
}

function ManualRow({ e, id, active, onFocus }: { e: ManualReviewEntry; id: string; active: boolean; onFocus: FocusIssue }) {
  const { t } = useI18n();
  const { formatPt } = useUnit();
  return (
    <RowButton active={active} onClick={() => onFocus(id, e.pageIndex, isAmbiguous(e) ? e.visibleBBoxPt : undefined)}>
      <StatusIcon tone="review" label={t('verdictManualReview')} className="text-sm" />
      <span className="mt-1 block text-sm">{t(MANUAL_TEXT[e.reason], { sides: sidesLabel(t, e.sides) })}</span>
      <span className="mt-0.5 block font-mono text-xs text-ink-muted">
        {e.reason}
        {e.maxAmountPt !== null && ` · ${t('mrMaxAmount', { amount: formatPt(e.maxAmountPt) })}`}
      </span>
    </RowButton>
  );
}

/** Confirmed problems and manual-review items, grouped by page. Clicking a
 * row sends the viewer to that page (and bbox when the engine gave one). */
export function IssueList({ inspection, afterFix, activeId, onFocus }: Props) {
  const { t } = useI18n();
  const confirmed = inspection.violations.map((v, i) => ({ v, id: violationId(i), pageIndex: v.pageIndex }));
  const manual = inspection.categories.margins.manualReview.map((e, i) => ({ e, id: manualId(i), pageIndex: e.pageIndex }));
  const total = confirmed.length + manual.length;
  const openAll = total <= 15;

  if (total === 0) return <p className="text-sm text-ink-muted">{t('noIssues')}</p>;

  return (
    <section aria-labelledby="issues-title" className="space-y-4" data-testid="issue-list">
      <h3 id="issues-title" className={sectionTitle}>
        {afterFix ? t('issuesRemainingAfterFix') : t('issuesTitle')}
      </h3>

      {confirmed.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">
            {t('issuesConfirmed')} ({confirmed.length})
          </h4>
          {groupByPage(confirmed).map((g, gi) => (
            <PageGroup key={g.pageIndex} page={g.pageIndex + 1} count={g.items.length} defaultOpen={openAll || gi === 0}>
              {g.items.map((it) => (
                <ViolationRow key={it.id} v={it.v} id={it.id} active={it.id === activeId} onFocus={onFocus} />
              ))}
            </PageGroup>
          ))}
        </div>
      )}

      {manual.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">
            {t('issuesManual')} ({manual.length})
          </h4>
          {groupByPage(manual).map((g, gi) => (
            <PageGroup key={g.pageIndex} page={g.pageIndex + 1} count={g.items.length} defaultOpen={openAll || gi === 0}>
              {g.items.map((it) => (
                <ManualRow key={it.id} e={it.e} id={it.id} active={it.id === activeId} onFocus={onFocus} />
              ))}
            </PageGroup>
          ))}
        </div>
      )}
    </section>
  );
}
