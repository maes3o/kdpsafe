import { describe, expect, it } from 'vitest';
import { buildHardGateCopy, buildPageCopy } from './copy';
import { STRINGS, type StringKey } from '../i18n/strings';
import type { SmartFixHardGateResult, SmartFixPreviewEntry, UserIntent } from '../engine/types';

function t(key: StringKey, vars?: Record<string, string | number>): string {
  const template = STRINGS.en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

const USER_INTENT: UserIntent = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: true };

describe('buildPageCopy', () => {
  it('renders a NONE entry (already compliant) with no proposal/jargon', () => {
    const entry: SmartFixPreviewEntry = {
      pageIndex: 0,
      before: { widthIn: 6, heightIn: 9, problem: null },
      after: null,
      strategyType: null,
      riskLevel: 'NONE',
      guarantees: [],
      explanation: 'стор. ОК',
    };
    const copy = buildPageCopy(t, entry, USER_INTENT);
    expect(copy.status).toBe('OK');
    expect(copy.proposal).toBeNull();
    expect(copy.headline).toBeNull();
    expect(copy.required).toBeNull();
  });

  it('renders the headline 8.5x11->6x9+bleed SCALE_PLUS_PADDING example from the spec, with no engine jargon', () => {
    const entry: SmartFixPreviewEntry = {
      pageIndex: 0,
      before: { widthIn: 8.5, heightIn: 11, problem: 'TOO_LARGE' },
      after: { widthIn: 6.125, heightIn: 9.25 },
      strategyType: 'SCALE_PLUS_PADDING',
      riskLevel: 'USER_CONFIRMATION',
      guarantees: ['(engine Ukrainian text, never shown to the EN user)'],
      explanation: 'engine explanation',
    };
    const copy = buildPageCopy(t, entry, USER_INTENT);
    expect(copy.status).toBe('ACTIONABLE');
    expect(copy.needsConfirmation).toBe(true);
    expect(copy.headline).toBe('This PDF has the wrong page size.');
    expect(copy.required).toBe('Required: 6 × 9 in + bleed');
    expect(copy.current).toBe('Current: 8.5 × 11 in');
    expect(copy.proposal).toBe('KDPSafe proposes: proportionally shrink the content and add the necessary margins.');
    // Must never leak the engine's own raw guarantee text.
    expect(copy.guarantees.join(' ')).not.toContain('engine Ukrainian text');
    expect(copy.guarantees.length).toBeGreaterThan(0);
    // No MediaBox/TrimBox/scaleFactor-style jargon anywhere in the copy.
    for (const text of [copy.headline, copy.required, copy.current, copy.proposal, ...copy.guarantees]) {
      expect(text?.toLowerCase()).not.toMatch(/mediabox|trimbox|bleedbox|scalefactor/);
    }
  });

  it('renders a SAFE_AUTOFIX PADDING page with no confirmation needed', () => {
    const entry: SmartFixPreviewEntry = {
      pageIndex: 1,
      before: { widthIn: 5.98, heightIn: 8.99, problem: 'TOO_SMALL' },
      after: { widthIn: 6, heightIn: 9 },
      strategyType: 'PADDING',
      riskLevel: 'SAFE_AUTOFIX',
      guarantees: [],
      explanation: '',
    };
    const copy = buildPageCopy(t, entry, { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false });
    expect(copy.status).toBe('ACTIONABLE');
    expect(copy.needsConfirmation).toBe(false);
    expect(copy.proposal).toContain('add blank margins');
    expect(copy.required).toBe('Required: 6 × 9 in');
  });

  it('renders MANUAL_REVIEW for a rotated page with the rotation-specific reason, not a generic one', () => {
    const entry: SmartFixPreviewEntry = {
      pageIndex: 2,
      before: { widthIn: 9, heightIn: 6, problem: 'NON_ZERO_ROTATION' },
      after: null,
      strategyType: null,
      riskLevel: 'MANUAL_REVIEW',
      guarantees: [],
      explanation: 'engine explanation',
    };
    const copy = buildPageCopy(t, entry, USER_INTENT);
    expect(copy.status).toBe('MANUAL_REVIEW');
    expect(copy.reasons).toHaveLength(1);
    expect(copy.reasons[0]).toMatch(/rotated/i);
    // A rotation problem is not itself a sizing headline.
    expect(copy.headline).toBeNull();
  });

  it('falls back to the generic "could not prove safe" reason for a self-declared-unsafe scale candidate (TOO_LARGE with no chosenStrategy)', () => {
    const entry: SmartFixPreviewEntry = {
      pageIndex: 3,
      before: { widthIn: 20, heightIn: 20, problem: 'TOO_LARGE' },
      after: null,
      strategyType: null,
      riskLevel: 'MANUAL_REVIEW',
      guarantees: [],
      explanation: 'engine explanation mentioning Dry-run internals',
    };
    const copy = buildPageCopy(t, entry, USER_INTENT);
    expect(copy.status).toBe('MANUAL_REVIEW');
    expect(copy.headline).toBe('This PDF has the wrong page size.');
    expect(copy.reasons[0]).toMatch(/could not prove/i);
    expect(copy.reasons[0]).not.toContain('Dry-run');
  });
});

describe('buildHardGateCopy', () => {
  it('maps ENCRYPTED and DIGITALLY_SIGNED to distinct, specific sentences', () => {
    const encrypted: SmartFixHardGateResult = { blocked: true, reasons: ['ENCRYPTED'] };
    const signed: SmartFixHardGateResult = { blocked: true, reasons: ['DIGITALLY_SIGNED'] };
    expect(buildHardGateCopy(t, encrypted)[0]).toMatch(/encrypted/i);
    expect(buildHardGateCopy(t, signed)[0]).toMatch(/signature/i);
    expect(buildHardGateCopy(t, encrypted)[0]).not.toBe(buildHardGateCopy(t, signed)[0]);
  });

  it('maps an unreadable-document reason without leaking the raw parser error', () => {
    const unreadable: SmartFixHardGateResult = { blocked: true, reasons: ['DOCUMENT_UNREADABLE: Invalid object ref: 2 0 R'] };
    const copy = buildHardGateCopy(t, unreadable);
    expect(copy[0]).toMatch(/could not read/i);
    expect(copy[0]).not.toContain('2 0 R');
  });
});
