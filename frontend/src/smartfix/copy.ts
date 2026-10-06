/**
 * Plain-language copy mapping for Smart Fix. Pure, dependency-free
 * functions (same discipline as engine/verdictDisplay.ts) that translate
 * Smart Fix's engine output -- SmartFixPreviewEntry / SmartFixHardGateResult
 * -- into the WHAT'S WRONG -> PROPOSAL -> WHY -> WHAT CHANGES copy the UI
 * needs, with zero MediaBox/TrimBox/scaleFactor jargon.
 *
 * This file NEVER re-decides anything Smart Fix already decided (which
 * strategy, which risk tier, whether the hard gate blocks) -- it only
 * chooses which already-fixed sentence to show for a `kind`/`riskLevel`/
 * `strategyType` the engine returned. It does not duplicate KDP policy:
 * the sentences here describe Smart Fix's OWN transform guarantees (never
 * moves content for PADDING/BOX_NORMALIZATION, shrink-only + annotations
 * move with content for the scale strategies) and do not encode or
 * restate any KDP margin/bleed numeric rule.
 *
 * The engine's own `guarantees`/`explanation`/`detail` strings are
 * hardcoded Ukrainian prose (not localized) -- deliberately NOT displayed
 * verbatim here, so the UI works correctly in both `en` and `uk` via the
 * existing i18n system instead.
 */

import type { StringKey } from '../i18n/strings';
import type {
  SmartFixHardGateResult,
  SmartFixPreviewEntry,
  SmartFixProblemKind,
  SmartFixRiskLevel,
  SmartFixStrategyType,
  UserIntent,
} from '../engine/types';

type T = (key: StringKey, vars?: Record<string, string | number>) => string;

function formatSize(widthIn: number, heightIn: number): string {
  return `${trimTrailingZeros(widthIn)} × ${trimTrailingZeros(heightIn)} in`;
}

function trimTrailingZeros(valueIn: number): string {
  return (Math.round(valueIn * 1000) / 1000).toString();
}

const PROPOSAL_KEY: Record<SmartFixStrategyType, StringKey> = {
  PROPORTIONAL_SCALE: 'sfProposalProportionalScale',
  SCALE_PLUS_PADDING: 'sfProposalScalePlusPadding',
  PADDING: 'sfProposalPadding',
  BOX_NORMALIZATION: 'sfProposalBoxNormalization',
};

const GUARANTEE_KEYS: Record<SmartFixStrategyType, StringKey[]> = {
  PROPORTIONAL_SCALE: ['sfGuaranteeScale', 'sfGuaranteeAnnotationsPreserved'],
  SCALE_PLUS_PADDING: ['sfGuaranteeScale', 'sfGuaranteeAnnotationsPreserved'],
  PADDING: ['sfGuaranteePadding', 'sfGuaranteeAnnotationsPreserved'],
  BOX_NORMALIZATION: ['sfGuaranteeBoxNormalization'],
};

const SIZING_PROBLEM_KINDS: ReadonlySet<SmartFixProblemKind> = new Set(['TOO_SMALL', 'TOO_LARGE', 'WRONG_ASPECT']);

const MANUAL_REVIEW_REASON_KEY: Partial<Record<SmartFixProblemKind, StringKey>> = {
  NON_ZERO_ROTATION: 'sfReasonRotation',
  NON_ZERO_ORIGIN: 'sfReasonNonZeroOrigin',
  BOX_CONFLICT: 'sfReasonBoxConflict',
  MISSING_TRIM_BOX: 'sfReasonMissingTarget',
};

export type SmartFixPageStatus = 'OK' | 'ACTIONABLE' | 'MANUAL_REVIEW';

export interface SmartFixPageCopy {
  pageIndex: number;
  status: SmartFixPageStatus;
  riskLevel: SmartFixRiskLevel | 'NONE';
  strategyType: SmartFixStrategyType | null;
  headline: string | null;
  current: string | null;
  required: string | null;
  proposal: string | null;
  guarantees: string[];
  reasons: string[];
  needsConfirmation: boolean;
}

export function buildPageCopy(t: T, entry: SmartFixPreviewEntry, userIntent: UserIntent): SmartFixPageCopy {
  const current = t('sfCurrent', { size: formatSize(entry.before.widthIn, entry.before.heightIn) });
  const requiredBase = formatSize(userIntent.trimSize.widthIn, userIntent.trimSize.heightIn);
  const required = t('sfRequired', { size: userIntent.bleed ? t('sfRequiredWithBleed', { size: requiredBase }) : requiredBase });

  if (entry.riskLevel === 'NONE') {
    return {
      pageIndex: entry.pageIndex,
      status: 'OK',
      riskLevel: 'NONE',
      strategyType: null,
      headline: null,
      current,
      required: null,
      proposal: null,
      guarantees: [],
      reasons: [],
      needsConfirmation: false,
    };
  }

  if (entry.strategyType && (entry.riskLevel === 'SAFE_AUTOFIX' || entry.riskLevel === 'USER_CONFIRMATION')) {
    const hasSizingProblem = entry.before.problem !== null && SIZING_PROBLEM_KINDS.has(entry.before.problem);
    return {
      pageIndex: entry.pageIndex,
      status: 'ACTIONABLE',
      riskLevel: entry.riskLevel,
      strategyType: entry.strategyType,
      headline: t(hasSizingProblem ? 'sfWrongSize' : 'sfMissingBoxMarkers'),
      current,
      required: hasSizingProblem ? required : null,
      proposal: `${t('sfProposalPrefix')} ${t(PROPOSAL_KEY[entry.strategyType])}`,
      guarantees: GUARANTEE_KEYS[entry.strategyType].map((key) => t(key)),
      reasons: [],
      needsConfirmation: entry.riskLevel === 'USER_CONFIRMATION',
    };
  }

  // riskLevel === 'MANUAL_REVIEW' (or a strategy self-declared unsafe,
  // which collapses to the same chosenStrategy===null outcome upstream).
  const problemKind = entry.before.problem;
  const reasonKey = problemKind ? MANUAL_REVIEW_REASON_KEY[problemKind] : undefined;
  const reasons = [t(reasonKey ?? 'sfReasonUnsafeAutomatic')];

  return {
    pageIndex: entry.pageIndex,
    status: 'MANUAL_REVIEW',
    riskLevel: 'MANUAL_REVIEW',
    strategyType: null,
    headline: problemKind && SIZING_PROBLEM_KINDS.has(problemKind) ? t('sfWrongSize') : null,
    current,
    required: problemKind && SIZING_PROBLEM_KINDS.has(problemKind) ? required : null,
    proposal: null,
    guarantees: [],
    reasons,
    needsConfirmation: false,
  };
}

const HARD_GATE_REASON_KEY: Array<{ test: (reason: string) => boolean; key: StringKey }> = [
  { test: (r) => r === 'ENCRYPTED', key: 'sfReasonEncrypted' },
  { test: (r) => r === 'DIGITALLY_SIGNED', key: 'sfReasonSigned' },
  { test: (r) => r.startsWith('DOCUMENT_UNREADABLE'), key: 'sfReasonUnreadable' },
];

export function buildHardGateCopy(t: T, hardGate: SmartFixHardGateResult): string[] {
  return hardGate.reasons.map((reason) => {
    const match = HARD_GATE_REASON_KEY.find((entry) => entry.test(reason));
    return t(match ? match.key : 'sfReasonUnreadable');
  });
}
