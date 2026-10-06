import { describe, expect, it } from 'vitest';
import { sanitizeExpandRequest } from './expandRequest';

describe('sanitizeExpandRequest (what the worker may forward to the engine)', () => {
  it('forwards only keep-origin + the confirmation flag', () => {
    expect(sanitizeExpandRequest({ anchor: 'keep-origin', confirmed: true })).toEqual({ anchor: 'keep-origin', confirmed: true });
    expect(sanitizeExpandRequest({ anchor: 'keep-origin', confirmed: false })).toEqual({ anchor: 'keep-origin', confirmed: false });
  });

  it('drops the centered anchor, the research switch and unknown fields: the production UI cannot reach research paths', () => {
    expect(sanitizeExpandRequest({ anchor: 'center', confirmed: true, research: true })).toEqual({ anchor: null, confirmed: true });
    expect(sanitizeExpandRequest({ anchor: 'keep-origin', confirmed: true, research: true, extra: 1 })).toEqual({ anchor: 'keep-origin', confirmed: true });
    expect(Object.keys(sanitizeExpandRequest({ anchor: 'keep-origin', confirmed: true, research: true })!).sort()).toEqual(['anchor', 'confirmed']);
  });

  it('is strict about confirmation and shape', () => {
    expect(sanitizeExpandRequest({ anchor: 'keep-origin', confirmed: 'yes' })).toEqual({ anchor: 'keep-origin', confirmed: false });
    expect(sanitizeExpandRequest(undefined)).toBeUndefined();
    expect(sanitizeExpandRequest(null)).toBeUndefined();
    expect(sanitizeExpandRequest('center')).toBeUndefined();
  });
});
