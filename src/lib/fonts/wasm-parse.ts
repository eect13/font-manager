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
 *
 * SIMD: parse is table-dir (KB), not glyf. SubtleCrypto SHA-256 already uses SHA-NI.
 * Duplicate-scan uses word-stride in binary-diff.ts (Uint32). A wasm SIMD crate
 * would re-parse what sfnt.ts already skips.
 *
 * WebGPU: available in WebView2 *and* the Grok browser (Chromium). It does **not**
 * draw library cards (CSS @font-face + DirectWrite/Skia already GPU-composite).
 * It does **not** AddFontResourceExW. A custom GPU glyph atlas is a second
 * renderer fighting Chromium text — Grok-preview and desktop UI both lose.
 */

export const PARSE_WORKER_MAX = 4;
export const LAYOUT_IPC_MAX_BYTES = 8_000_000;
export const CMAP_IPC_MAX_BYTES = 180_000;
/** Glyph-map rows. UnifontEX ~50k would hitch the inspector; BMP-ish cap. */
export const CMAP_GLYPH_CAP = 8192;

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
