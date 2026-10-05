import type { BBoxPt } from '../../engine/types';

export type MarkKind = 'problem' | 'review' | 'fixed';

/** A real engine bbox to outline on a page (PDF points, engine coordinates). */
export interface ViewerMark {
  id: string;
  pageIndex: number;
  bbox: BBoxPt;
  kind: MarkKind;
}

/** Ask the viewer to scroll to a page, and to a bbox on it when given. */
export interface ViewerFocus {
  pageIndex: number;
  bbox?: BBoxPt;
  /** Changes on every request so clicking the same issue twice re-scrolls. */
  nonce: number;
}
