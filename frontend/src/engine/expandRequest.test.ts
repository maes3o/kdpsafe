import { describe, expect, it } from 'vitest';
import { buildEngineOptions, sanitizeExpandRequest } from './expandRequest';

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

describe('buildEngineOptions (the worker -> engine boundary)', () => {
  const intent = { trimSize: { widthIn: 6, heightIn: 9 }, bleed: false };

  it('never forwards pageContext (a caller cannot choose the page count / gutter row)', () => {
    const out = buildEngineOptions({ userIntent: intent, pageContext: { pageCount: 900, pageNumber: 3 } });
    expect(out).not.toHaveProperty('pageContext');
    expect(Object.keys(out).sort()).toEqual(['expandPage', 'userIntent']);
    expect(out.userIntent).toBe(intent);
  });

  it('forwards only userIntent and the sanitized expand request', () => {
    const out = buildEngineOptions({ userIntent: intent, pageContext: { pageCount: 1 }, expandPage: { anchor: 'center', confirmed: true, research: true }, extra: true });
    expect(out).toEqual({ userIntent: intent, expandPage: { anchor: null, confirmed: true } });
  });

  it('tolerates garbage', () => {
    expect(buildEngineOptions(undefined)).toEqual({ userIntent: undefined, expandPage: undefined });
    expect(buildEngineOptions('x')).toEqual({ userIntent: undefined, expandPage: undefined });
  });
});
