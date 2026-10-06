import { describe, expect, it } from 'vitest';
import { matchPreset, suggestFromPageSize } from './kdpSizes';

describe('kdpSizes (input hints only)', () => {
  it('recognises a preset without bleed and with bleed', () => {
    expect(suggestFromPageSize(6, 9)).toMatchObject({ preset: { id: '6x9' }, bleed: false });
    expect(suggestFromPageSize(6.125, 9.25)).toMatchObject({ preset: { id: '6x9' }, bleed: true });
  });
  it('returns null for an unknown page size and matchPreset is exact', () => {
    expect(suggestFromPageSize(4.2, 4.2)).toBeNull();
    expect(matchPreset(6, 9)?.id).toBe('6x9');
    expect(matchPreset(6, 9.1)).toBeNull();
  });
});
