/**
 * Browser `Buffer` for the frozen engine's autofix path
 * (lib/geometryRewriter.js / lib/pdfAutofixWriter.js call Buffer.from /
 * Buffer.concat). Imported FIRST in the worker, for its side effect only.
 * The trailing slash in 'buffer/' forces the npm package instead of the
 * bundler's externalized Node builtin.
 */
import { Buffer } from 'buffer/';

const g = globalThis as { Buffer?: unknown };
if (!g.Buffer) g.Buffer = Buffer;
