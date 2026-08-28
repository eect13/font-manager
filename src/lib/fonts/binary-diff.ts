/** Count differing bytes. Stops after `limit` so unlike files exit early. */
export function countByteDiffs(a: Uint8Array, b: Uint8Array, limit = Infinity): number {
  const n = Math.min(a.length, b.length);
  let diffs = Math.abs(a.length - b.length);
  if (diffs > limit) return diffs;
  for (let i = 0; i < n; i += 1) {
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
