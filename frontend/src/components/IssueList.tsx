import { useI18n } from '../i18n/context';
import type { BBoxPt, InspectionResult, ManualReviewEntry, PageGeometryAssessment, Violation } from '../engine/types';
import { formatPoints, objectLabel, sideLabel, sidesLabel } from '../i18n/labels';
import { useUnit } from '../units/context';
import type { StringKey } from '../i18n/strings';
import { groupByPage, isAmbiguous, manualDisplayItems, outsideTrimGroup, pageCountOutsideMarginTable, OUTSIDE_TRIM_GROUP_ID, violationId, type ManualDisplayItem, type OutsideTrimGroup } from '../workspace/issues';
import { formatPageRanges } from '../i18n/labels';
import { StatusIcon } from './StatusIcon';
import { sectionTitle } from './ui';

const MANUAL_TEXT: Record<ManualReviewEntry['reason'], StringKey> = {
  LEM_ORIENTATION_AMBIGUOUS: 'mrAmbiguous',
  BLEED_VIOLATION: 'mrBleed',
  TEXT_LEM_VIOLATION: 'mrText',
  LEM_VIOLATION_OVER_AUTOFIX_THRESHOLD: 'mrOverThreshold',
  HORIZONTAL_GEOMETRY_UNRESOLVED: 'mrUnresolved',
  PAGE_ROTATION_UNSUPPORTED: 'mrRotation',
};

export type FocusIssue = (id: string, pageIndex: number, bbox?: BBoxPt) => void;

interface Props {
  inspection: InspectionResult;
  geometry: PageGeometryAssessment | null;
  afterFix: boolean;
  activeId: string | null;
  onFocus: FocusIssue;
}

function PageGroup({ page, count, defaultOpen, children }: { page: number; count: number; defaultOpen: boolean; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <details open={defaultOpen} className="overflow-hidden rounded-2xl border border-border bg-bg shadow-card">
      <summary className="flex cursor-pointer items-center justify-between px-3 py-2.5 text-sm font-bold">
        <span>{t('pageNumber', { page })}</span>
        <span className="text-xs font-normal text-ink-muted">{t('pageGroupCount', { n: count })}</span>
      </summary>
      <ul className="divide-y divide-border border-t border-border">{children}</ul>
    </details>
  );
}

function RowButton({ active, onClick, children, tech }: { active: boolean; onClick: () => void; children: React.ReactNode; tech?: React.ReactNode }) {
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
        <span className="mt-1.5 block text-sm font-semibold text-accent">{t('showInPdf')} →</span>
        {tech && <span className="mt-1 block font-mono text-[11px] text-ink-muted/80">{tech}</span>}
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
    <RowButton
      active={active}
      onClick={() => onFocus(id, v.pageIndex, v.visibleBBoxPt)}
      tech={`${v.violation} · ${v.side} · ${formatPoints(v.amountPt, formatNumber, t('pointsShort'))}`}
    >
      <StatusIcon tone={v.severity === 'error' ? 'error' : 'attention'} label={v.severity === 'error' ? t('severityError') : t('severityWarning')} className="text-sm" />
      <span className="mt-1 block text-sm">{text}</span>
    </RowButton>
  );
}

/** One summary row for many "completely outside the trim" objects (crop
 * marks / slug). Display only: every raw violation stays in the result. */
function OutsideTrimRow({ group, first, active, onFocus }: { group: OutsideTrimGroup; first: Violation; active: boolean; onFocus: FocusIssue }) {
  const { t } = useI18n();
  return (
    <li className="overflow-hidden rounded-2xl border border-border bg-bg shadow-card" data-testid="outside-trim-group">
      <RowButton
        active={active}
        onClick={() => onFocus(OUTSIDE_TRIM_GROUP_ID, first.pageIndex, first.visibleBBoxPt)}
        tech={`LEM × ${group.indices.length} · outside TrimBox`}
      >
        <StatusIcon tone="error" label={t('severityError')} className="text-sm" />
        <span className="mt-1 block text-sm font-semibold">{t('issueOutsideTrimTitle')}</span>
        <span className="mt-1 block text-sm">{t('issueOutsideTrim', { n: group.indices.length, pages: formatPageRanges(group.pages) })}</span>
      </RowButton>
    </li>
  );
}

function ManualRow({
  item,
  active,
  onFocus,
  trimBoxMissing,
  pageCount,
}: {
  item: ManualDisplayItem;
  active: boolean;
  onFocus: FocusIssue;
  trimBoxMissing: boolean;
  pageCount: number;
}) {
  const { t } = useI18n();
  const { formatPt } = useUnit();
  const e = item.entry;
  // The engine's generic "unresolved" reason is explained by the missing
  // TrimBox when that is the document-level cause (see the page-size card).
  const text =
    e.reason === 'HORIZONTAL_GEOMETRY_UNRESOLVED' && pageCountOutsideMarginTable(pageCount)
      ? t('mrUnresolvedPageCount', { sides: sidesLabel(t, e.sides), n: pageCount })
      : e.reason === 'HORIZONTAL_GEOMETRY_UNRESOLVED' && trimBoxMissing
        ? t('mrUnresolvedNoTrimBox')
        : t(MANUAL_TEXT[e.reason], { sides: sidesLabel(t, e.sides) });
  return (
    <RowButton
      active={active}
      onClick={() => onFocus(item.id, e.pageIndex, isAmbiguous(e) ? e.visibleBBoxPt : undefined)}
      tech={`${e.reason}${e.maxAmountPt !== null ? ` · ${t('mrMaxAmount', { amount: formatPt(e.maxAmountPt) })}` : ''}`}
    >
      <StatusIcon tone="review" label={t('verdictManualReview')} className="text-sm font-bold uppercase tracking-wider" />
      <span className="mt-1 block text-sm">{text}</span>
      {item.group && <span className="mt-1 block text-sm font-semibold">{t('mrPagesLabel', { pages: formatPageRanges(item.pages) })}</span>}
    </RowButton>
  );
}

/** Confirmed problems and manual-review items, grouped by page. Clicking a
 * row sends the viewer to that page (and bbox when the engine gave one). */
export function IssueList({ inspection, geometry, afterFix, activeId, onFocus }: Props) {
  const { t } = useI18n();
  const outside = outsideTrimGroup(inspection, geometry);
  const grouped = new Set(outside?.indices ?? []);
  const confirmed = inspection.violations
    .map((v, i) => ({ v, id: violationId(i), pageIndex: v.pageIndex, i }))
    .filter((c) => !grouped.has(c.i));
  const confirmedCount = confirmed.length + (outside ? 1 : 0);
  const manualItems = manualDisplayItems(inspection);
  const groups = manualItems.filter((m) => m.group);
  const manual = manualItems.filter((m) => !m.group).map((m) => ({ m, id: m.id, pageIndex: m.entry.pageIndex }));
  const manualTotal = groups.length + manual.length;
  const trimBoxMissing = geometry ? geometry.trimBox !== 'explicit' : false;
  const total = confirmedCount + manualTotal;
  const openAll = total <= 15;

  if (total === 0) return <p className="text-sm text-ink-muted">{t('noIssues')}</p>;

  return (
    <section aria-labelledby="issues-title" className="space-y-4" data-testid="issue-list">
      <h3 id="issues-title" className={sectionTitle}>
        {afterFix ? t('issuesRemainingAfterFix') : t('issuesTitle')}
      </h3>

      {confirmedCount > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">
            {t('issuesConfirmed')} ({confirmedCount})
          </h4>
          {outside && (
            <ul className="space-y-2">
              <OutsideTrimRow group={outside} first={inspection.violations[outside.indices[0]]} active={activeId === OUTSIDE_TRIM_GROUP_ID} onFocus={onFocus} />
            </ul>
          )}
          {groupByPage(confirmed).map((g, gi) => (
            <PageGroup key={g.pageIndex} page={g.pageIndex + 1} count={g.items.length} defaultOpen={openAll || gi === 0}>
              {g.items.map((it) => (
                <ViolationRow key={it.id} v={it.v} id={it.id} active={it.id === activeId} onFocus={onFocus} />
              ))}
            </PageGroup>
          ))}
        </div>
      )}

      {manualTotal > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">
            {t('issuesManual')} ({manualTotal})
          </h4>
          {groups.length > 0 && (
            <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg shadow-card">
              {groups.map((g) => (
                <ManualRow key={g.id} item={g} active={g.id === activeId} onFocus={onFocus} trimBoxMissing={trimBoxMissing} pageCount={inspection.document.pageCount} />
              ))}
            </ul>
          )}
          {groupByPage(manual).map((g, gi) => (
            <PageGroup key={g.pageIndex} page={g.pageIndex + 1} count={g.items.length} defaultOpen={openAll || gi === 0}>
              {g.items.map((it) => (
                <ManualRow key={it.id} item={it.m} active={it.id === activeId} onFocus={onFocus} trimBoxMissing={trimBoxMissing} pageCount={inspection.document.pageCount} />
              ))}
            </PageGroup>
          ))}
        </div>
      )}
    </section>
  );
}
