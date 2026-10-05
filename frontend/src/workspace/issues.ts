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
