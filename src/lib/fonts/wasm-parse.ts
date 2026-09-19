/**
 * Parse-engine policy for Font Manager.
 *
 * WASM ttf-parser would duplicate desktop `src-tauri` ttf-parser and JS `sfnt.ts`
 * (table directory, no glyf). Cost of a second crate + wasm-bindgen is not the
 * 20k bottleneck. The bottleneck is one worker cloning File and IPC `Array.from`.
 *
 * Engines, in order:
 *   1. sfnt-js        outline-free table parse (TTF/OTF/WOFF1/TTC)
 *   2. SubtleCrypto   SHA-256 (native, faster than hash-wasm)
 *   3. native-ttf     desktop ttf-parser via Uint8Array IPC (layout/cmap)
 *   4. opentype.js    last resort — parses glyf; WOFF2 / odd wrappers
 *
 * Do not add harfbuzz-wasm / pyftsubset / hb-subset here. GDI Documents stay full TTFs.
 */

export const PARSE_WORKER_MAX = 4;
export const LAYOUT_IPC_MAX_BYTES = 8_000_000;
export const CMAP_IPC_MAX_BYTES = 180_000;

export function parseWorkerCount(cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2) {
  const n = Number(cores);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.max(1, Math.min(PARSE_WORKER_MAX, Math.floor(n)));
}

export function shouldUseIpcLayout(byteLength: number) {
  return byteLength > 0 && byteLength <= LAYOUT_IPC_MAX_BYTES;
}

export function shouldUseIpcCmap(byteLength: number) {
  return byteLength > 0 && byteLength <= CMAP_IPC_MAX_BYTES;
}
