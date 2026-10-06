/** Maps engine enum values to localized UI text. Engine values stay untouched. */

import type { I18nContextValue } from './context';
import { STRINGS, type StringKey } from './strings';

const STRING_KEYS = Object.keys(STRINGS.en);
import type { IntegrityFinding, ObjectType, Side } from '../engine/types';

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

/** Geometry reason code -> localized sentence (falls back to a generic one). */
export function geometryReasonLabel(t: T, code: string): string {
  const key = `geoReason_${code}` as StringKey;
  // Dynamic key: only codes present in the dictionary resolve.
  return (STRING_KEYS as readonly string[]).includes(key) ? t(key) : t('geoReasonUnknown');
}

/** Expand-page rejection code -> localized sentence. */
export function expandReasonLabel(t: T, code: string): string {
  const key = `expandReason_${code}` as StringKey;
  return (STRING_KEYS as readonly string[]).includes(key) ? t(key) : t('geoReasonUnknown');
}

export function safetyCheckLabel(t: T, id: string): string {
  const key = `chk_${id}` as StringKey;
  return (STRING_KEYS as readonly string[]).includes(key) ? t(key) : id;
}

/** "1–30" or "1, 3, 5–7" from 1-based page numbers. */
export function formatPageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i] !== sorted[i - 1] + 1) {
      const a = sorted[start];
      const b = sorted[i - 1];
      parts.push(a === b ? String(a) : `${a}–${b}`);
      start = i;
    }
  }
  return parts.join(', ');
}

// ---- Phase 2A integrity findings ----


export function integrityTitle(t: T, id: string): string {
  const key = `integrity_${id}` as StringKey;
  return (STRING_KEYS as readonly string[]).includes(key) ? t(key) : id;
}

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/** Short explanation of a finding: by check id + machine code, with a generic
 * fallback so an unknown code is never shown as a pass or as a blank. */
export function integrityExplanation(t: T, f: IntegrityFinding): string {
  const d = f.details as Record<string, unknown>;
  const e = (f.evidence ?? {}) as Record<string, unknown>;
  const fontNames = Array.isArray(d.fonts) ? (d.fonts as { font?: string }[]).map((x) => x.font).filter(Boolean).slice(0, 5).join(', ') : '';
  const types = e.otherSubtypes && typeof e.otherSubtypes === 'object' ? Object.keys(e.otherSubtypes as object).join(', ') : '';
  const params = {
    n: Number(d.items ?? 0),
    count: Number(d.comments ?? e.links ?? e.belowReference ?? 0),
    min: Number(e.minEffectiveDpi ?? 0),
    fonts: fontNames || (f.objects ?? []).slice(0, 5).join(', '),
    types,
    size: typeof d.sizeBytes === 'number' ? mb(d.sizeBytes) : '',
  };
  const specific = `integrity_${f.id}_${f.code}` as StringKey;
  if ((STRING_KEYS as readonly string[]).includes(specific)) return t(specific, params);
  const generic = `integrity_generic_${f.code}` as StringKey;
  if ((STRING_KEYS as readonly string[]).includes(generic)) return t(generic);
  return t('integrity_generic_UNKNOWN');
}
