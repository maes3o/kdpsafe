import { describe, expect, it } from 'vitest';
import { verdictDisplay } from './verdictDisplay';

describe('verdictDisplay', () => {
  it('maps READY to the check icon and glyph, per the STATUS RULE', () => {
    const d = verdictDisplay('READY');
    expect(d.icon).toBe('check');
    expect(d.glyph).toBe('✓');
    expect(d.labelKey).toBe('verdictReady');
  });

  it('maps NEEDS_ATTENTION to the warning icon and glyph', () => {
    const d = verdictDisplay('NEEDS_ATTENTION');
    expect(d.icon).toBe('warning');
    expect(d.glyph).toBe('!');
    expect(d.labelKey).toBe('verdictNeedsAttention');
  });

  it('maps MANUAL_REVIEW_REQUIRED to the question icon and glyph', () => {
    const d = verdictDisplay('MANUAL_REVIEW_REQUIRED');
    expect(d.icon).toBe('question');
    expect(d.glyph).toBe('?');
    expect(d.labelKey).toBe('verdictManualReview');
  });

  it('never returns the cross/PROBLEM icon for any engine Verdict (that belongs to app-level error state only)', () => {
    const verdicts = ['READY', 'NEEDS_ATTENTION', 'MANUAL_REVIEW_REQUIRED'] as const;
    for (const v of verdicts) {
      expect(verdictDisplay(v).icon).not.toBe('cross');
    }
  });
});
