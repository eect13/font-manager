/** Count differing bytes. Stops after `limit` so unlike files exit early.
 *  Word-stride (Uint32) on aligned buffers — JS SIMD-without-WASM. Equal files
 *  skip 4 bytes per compare; SHA-256 stays SubtleCrypto (SHA-NI), not this loop. */
export function countByteDiffs(a: Uint8Array, b: Uint8Array, limit = Infinity): number {
  const n = Math.min(a.length, b.length);
  let diffs = Math.abs(a.length - b.length);
  if (diffs > limit) return diffs;
  let i = 0;
  if ((a.byteOffset & 3) === 0 && (b.byteOffset & 3) === 0 && n >= 4) {
    const words = n >>> 2;
    const wa = new Uint32Array(a.buffer, a.byteOffset, words);
    const wb = new Uint32Array(b.buffer, b.byteOffset, words);
    for (let w = 0; w < words; w += 1) {
      if (wa[w] !== wb[w]) {
        const base = w << 2;
        if (a[base] !== b[base]) diffs += 1;
        if (a[base + 1] !== b[base + 1]) diffs += 1;
        if (a[base + 2] !== b[base + 2]) diffs += 1;
        if (a[base + 3] !== b[base + 3]) diffs += 1;
        if (diffs > limit) return diffs;
      }
    }
    i = words << 2;
  }
  for (; i < n; i += 1) {
    if (a[i] !== b[i]) {
      diffs += 1;
      if (diffs > limit) return diffs;
    }
  }
  return diffs;
}

/** Same-size files: identical, or only a tiny patch (typical name-table edit). */
export function bytesNearlySame(a: Uint8Array, b: Uint8Array): { near: boolean; diffs: number } {
  if (a.length !== b.length) {
    return { near: false, diffs: Math.abs(a.length - b.length) };
  }
  const cap = Math.max(128, Math.floor(a.length * 0.001));
  const diffs = countByteDiffs(a, b, cap);
  return { near: diffs <= cap, diffs };
}
