/**
 * Pure presentation helpers over an engine result: splitting and grouping
 * only. Nothing here decides compliance -- every verdict, violation,
 * manual-review entry and plan comes straight from the engine.
 */

import type {
  AmbiguousOrientationEntry,
  AutofixPlan,
  InspectionResult,
  ManualReviewEntry,
  OtherManualReviewEntry,
} from '../engine/types';

export function ambiguousEntries(result: InspectionResult): AmbiguousOrientationEntry[] {
  return result.categories.margins.manualReview.filter(
    (e): e is AmbiguousOrientationEntry => e.reason === 'LEM_ORIENTATION_AMBIGUOUS'
  );
}

export function otherManualEntries(result: InspectionResult): OtherManualReviewEntry[] {
  return result.categories.margins.manualReview.filter(
    (e): e is OtherManualReviewEntry => e.reason !== 'LEM_ORIENTATION_AMBIGUOUS'
  );
}

export function isAmbiguous(e: ManualReviewEntry): e is AmbiguousOrientationEntry {
  return e.reason === 'LEM_ORIENTATION_AMBIGUOUS';
}

export function applyablePlans(result: InspectionResult): AutofixPlan[] {
  return result.autofixPlans.filter((p) => p.applyable);
}

export function groupByPage<T extends { pageIndex: number }>(items: T[]): { pageIndex: number; items: T[] }[] {
  const map = new Map<number, T[]>();
  for (const item of items) {
    const list = map.get(item.pageIndex);
    if (list) list.push(item);
    else map.set(item.pageIndex, [item]);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([pageIndex, list]) => ({ pageIndex, items: list }));
}

/** 1-based, de-duplicated, sorted page numbers. */
export function pageNumbers(items: { pageIndex: number }[]): number[] {
  return [...new Set(items.map((i) => i.pageIndex + 1))].sort((a, b) => a - b);
}

// ---- viewer marks (ids shared between the issue list and the viewer) ----

import type { ViewerMark } from '../components/viewer/types';

export const violationId = (i: number) => `v-${i}`;
export const manualId = (i: number) => `m-${i}`;
export const planId = (i: number) => `p-${i}`;

/** Outlines for every engine finding that carries a real bbox. Manual-review
 * entries without a bbox (everything except orientation ambiguity) simply
 * have no outline -- coordinates are never invented. */
export function buildMarks(result: InspectionResult | null): ViewerMark[] {
  if (!result) return [];
  const marks: ViewerMark[] = [];
  result.violations.forEach((v, i) =>
    marks.push({ id: violationId(i), pageIndex: v.pageIndex, bbox: v.visibleBBoxPt, kind: 'problem' })
  );
  result.categories.margins.manualReview.forEach((e, i) => {
    if (isAmbiguous(e)) marks.push({ id: manualId(i), pageIndex: e.pageIndex, bbox: e.visibleBBoxPt, kind: 'review' });
  });
  return marks;
}

// ---- display grouping of manual-review entries (presentation only) ----

export interface ManualDisplayItem {
  /** `m-<index>` for a single entry (matches viewer marks), `mg-...` for a group. */
  id: string;
  entry: ManualReviewEntry;
  /** Index of `entry` in the engine's manualReview[] (first one for a group). */
  index: number;
  /** 1-based pages the item covers (more than one only for a group). */
  pages: number[];
  group: boolean;
}

/**
 * The engine reports one manual-review entry per page. When many pages share
 * the SAME document-level cause (e.g. "no TrimBox" on all 30 pages) the UI
 * shows one grouped item instead of 30 identical ones. Authoritative
 * per-page data stays in the engine result (and the technical details);
 * entries that carry a location (orientation ambiguity) are never grouped.
 */
export function manualDisplayItems(result: InspectionResult): ManualDisplayItem[] {
  const entries = result.categories.margins.manualReview;
  const buckets = new Map<string, number[]>();
  entries.forEach((e, i) => {
    if (isAmbiguous(e)) return;
    const key = `${e.reason}|${[...e.sides].sort().join(',')}`;
    const list = buckets.get(key);
    if (list) list.push(i);
    else buckets.set(key, [i]);
  });
  const items: ManualDisplayItem[] = [];
  const emitted = new Set<string>();
  entries.forEach((e, i) => {
    if (isAmbiguous(e)) {
      items.push({ id: manualId(i), entry: e, index: i, pages: [e.pageIndex + 1], group: false });
      return;
    }
    const key = `${e.reason}|${[...e.sides].sort().join(',')}`;
    const idxs = buckets.get(key)!;
    if (idxs.length === 1) {
      items.push({ id: manualId(i), entry: e, index: i, pages: [e.pageIndex + 1], group: false });
    } else if (!emitted.has(key)) {
      emitted.add(key);
      items.push({ id: `mg-${key}`, entry: e, index: i, pages: idxs.map((k) => entries[k].pageIndex + 1), group: true });
    }
  });
  return items;
}
