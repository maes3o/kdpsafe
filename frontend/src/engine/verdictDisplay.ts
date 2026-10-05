/**
 * Pure mapping: engine verdict -> icon + label. Kept as a standalone,
 * dependency-free function (not a component) specifically so it is
 * directly unit-testable and so the STATUS RULE ("never color alone,
 * always icon + text") is enforced in exactly one place rather than
 * re-decided per component.
 */

import type { Verdict } from './types';
import type { StringKey } from '../i18n/strings';

export type StatusIconKind = 'check' | 'warning' | 'cross' | 'question';

export interface VerdictDisplay {
  icon: StatusIconKind;
  /** Icon glyph exactly as specified by the product spec's STATUS RULE. */
  glyph: string;
  labelKey: StringKey;
}

const VERDICT_DISPLAY: Record<Verdict, VerdictDisplay> = {
  READY: { icon: 'check', glyph: '✓', labelKey: 'verdictReady' },
  NEEDS_ATTENTION: { icon: 'warning', glyph: '!', labelKey: 'verdictNeedsAttention' },
  MANUAL_REVIEW_REQUIRED: { icon: 'question', glyph: '?', labelKey: 'verdictManualReview' },
};

export function verdictDisplay(verdict: Verdict): VerdictDisplay {
  return VERDICT_DISPLAY[verdict];
}
