/** Maps engine enum values to localized UI text. Engine values stay untouched. */

import type { I18nContextValue } from './context';
import type { StringKey } from './strings';
import type { ObjectType, Side } from '../engine/types';

type T = I18nContextValue['t'];

const OBJECT: Record<ObjectType, StringKey> = { text: 'objText', image: 'objImage', path: 'objPath' };
const SIDE: Record<Side, StringKey> = {
  top: 'sideTop',
  bottom: 'sideBottom',
  left: 'sideLeft',
  right: 'sideRight',
};

export const objectLabel = (t: T, o: ObjectType) => t(OBJECT[o]);
export const sideLabel = (t: T, s: Side) => t(SIDE[s]);
export const sidesLabel = (t: T, sides: Side[]) => sides.map((s) => sideLabel(t, s)).join(', ');

const SKIP: Record<string, StringKey> = {
  page_not_found: 'skipPageNotFound',
  no_content_stream: 'skipNoContent',
  multi_stream_contents_unsupported: 'skipMultiStream',
  ambiguous_rect_match: 'skipAmbiguous',
  rect_not_found: 'skipRectNotFound',
};
export const skipReasonLabel = (t: T, reason: string) => t(SKIP[reason] ?? 'skipUnknown');

const VERIFICATION: Record<string, StringKey> = {
  NO_APPLICABLE_AUTOFIX: 'reasonNoApplicable',
  AUTOFIX_NOT_SAFELY_APPLICABLE: 'reasonNotSafelyApplicable',
  GEOMETRY_UNRESOLVED: 'reasonGeometryUnresolved',
  ISSUE_REMAINS: 'reasonIssueRemains',
  NEW_VIOLATIONS_AFTER_FIX: 'reasonNewViolations',
  MANUAL_REVIEW_REMAINS: 'reasonManualReviewRemains',
};
export const verificationReasonLabel = (t: T, reason: string) => t(VERIFICATION[reason] ?? 'reasonUnknown');

const PT_PER_INCH = 72; // unit conversion for display only

export const ptToIn = (pt: number) => pt / PT_PER_INCH;

/** "0.075 in" -- primary, human unit. */
export function formatInches(pt: number, format: (v: number, max?: number) => string, unit: string): string {
  return `${format(ptToIn(Math.abs(pt)), 3)} ${unit}`;
}

/** "5.4 pt" -- secondary, technical unit. */
export function formatPoints(pt: number, format: (v: number, max?: number) => string, unit: string): string {
  return `${format(Math.abs(pt), 1)} ${unit}`;
}
