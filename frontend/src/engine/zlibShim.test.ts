// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { deflateSync } from './zlibShim';

describe('browser zlib shim', () => {
  it('produces a zlib container that standard zlib (what /FlateDecode readers use) inflates back exactly', () => {
    const input = new TextEncoder().encode('q 0.2 g 100 300 100 334 re f Q\n'.repeat(50));
    const out = deflateSync(input);
    expect(out[0] & 0x0f).toBe(8); // CM = deflate, RFC 1950 header
    expect(Buffer.from(inflateSync(out)).equals(Buffer.from(input))).toBe(true);
  });
});
