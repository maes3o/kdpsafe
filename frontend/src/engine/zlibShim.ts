/**
 * Browser stand-in for Node's `zlib`, aliased in vite.config.ts. The engine
 * only ever calls `zlib.deflateSync(buf)` to re-encode a patched content
 * stream for /FlateDecode; `zlibSync` from fflate produces the same
 * zlib-wrapped DEFLATE container (RFC 1950), so the PDF filter contract is
 * unchanged. The AFTER preflight re-parses these bytes regardless.
 */
import { zlibSync } from 'fflate';

export function deflateSync(data: Uint8Array): Uint8Array {
  return zlibSync(data);
}

export default { deflateSync };
