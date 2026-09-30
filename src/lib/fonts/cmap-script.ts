/**
 * Card 36: pick a font's preview script from the characters it actually contains
 * (its `cmap`), not from its name — a renamed Arabic upload previews Arabic, rtl.
 * The name still wins when it names a script the font really covers (it is more
 * specific, e.g. JP vs SC for a CJK font that has both kana and hanzi).
 */
import { META_KINDS, metaSample, scriptOf, type ScriptKind } from "./scripts";

export type Coverage = (cp: number) => boolean;

function tableDir(b: DataView): Map<string, { off: number; len: number }> {
  const out = new Map<string, { off: number; len: number }>();
  if (b.byteLength < 12) return out;
  const n = b.getUint16(4);
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    if (o + 16 > b.byteLength) break;
    const tag = String.fromCharCode(b.getUint8(o), b.getUint8(o + 1), b.getUint8(o + 2), b.getUint8(o + 3));
    out.set(tag, { off: b.getUint32(o + 8), len: b.getUint32(o + 12) });
  }
  return out;
}

function format12(b: DataView, at: number): Coverage | null {
  const n = b.getUint32(at + 12);
  if (at + 16 + n * 12 > b.byteLength) return null;
  const groups: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const g = at + 16 + 12 * i;
    if (b.getUint32(g + 8) === 0 && b.getUint32(g) === b.getUint32(g + 4)) continue;
    groups.push([b.getUint32(g), b.getUint32(g + 4)]);
  }
  return (cp) => {
    let lo = 0;
    let hi = groups.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [s, e] = groups[mid]!;
      if (cp < s) hi = mid - 1;
      else if (cp > e) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

function format4(b: DataView, at: number): Coverage | null {
  const segX2 = b.getUint16(at + 6);
  const segs = segX2 / 2;
  const ends = at + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  if (ranges + segX2 > b.byteLength) return null;
  return (cp) => {
    if (cp > 0xffff) return false;
    for (let i = 0; i < segs; i++) {
      const end = b.getUint16(ends + 2 * i);
      if (cp > end) continue;
      const start = b.getUint16(starts + 2 * i);
      if (cp < start) return false;
      const ro = b.getUint16(ranges + 2 * i);
      const delta = b.getUint16(deltas + 2 * i);
      if (ro === 0) return ((cp + delta) & 0xffff) !== 0;
      const gAt = ranges + 2 * i + ro + 2 * (cp - start);
      if (gAt + 2 > b.byteLength) return false;
      const g = b.getUint16(gAt);
      return g !== 0 && ((g + delta) & 0xffff) !== 0;
    }
    return false;
  };
}

/** Unicode coverage of a single SFNT face (TrueType or CFF), or null if unreadable. */
export function cmapCoverage(buffer: ArrayBuffer | Uint8Array): Coverage | null {
  try {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const b = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cmap = tableDir(b).get("cmap");
    if (!cmap || cmap.off + 4 > b.byteLength) return null;
    const n = b.getUint16(cmap.off + 2);
    let best: { rank: number; at: number; format: number } | null = null;
    for (let i = 0; i < n; i++) {
      const r = cmap.off + 4 + 8 * i;
      if (r + 8 > b.byteLength) break;
      const plat = b.getUint16(r);
      const enc = b.getUint16(r + 2);
      const at = cmap.off + b.getUint32(r + 4);
      if (at + 4 > b.byteLength) continue;
      const format = b.getUint16(at);
      const unicode = plat === 0 || (plat === 3 && (enc === 1 || enc === 10));
      if (!unicode || (format !== 4 && format !== 12)) continue;
      const rank = format === 12 ? 2 : 1;
      if (!best || rank > best.rank) best = { rank, at, format };
    }
    if (!best) return null;
    return best.format === 12 ? format12(b, best.at) : format4(b, best.at);
  } catch {
    return null;
  }
}

const LATIN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Scripts every good Latin font also carries — only a preview when Latin is absent. */
const LATIN_COMPANIONS = new Set<ScriptKind>(["cyrillic", "greek"]);
const CJK = new Set<ScriptKind>(["jp", "kr", "sc", "tc", "hk"]);
const SKIP = new Set<ScriptKind>(["latin", "other", "emoji", ...CJK]);

function share(has: Coverage, text: string) {
  const chars = Array.from(text).filter((c) => /[\p{L}\p{M}]/u.test(c));
  if (!chars.length) return 0;
  return chars.filter((c) => has(c.codePointAt(0)!)).length / chars.length;
}

function cjkKind(has: Coverage): ScriptKind | null {
  if (has(0x3042) && has(0x30a2)) return "jp";
  if (has(0xac00) && has(0xd55c)) return "kr";
  if (has(0x4e00) && has(0x5b57)) return has(0x9ad4) && !has(0x4f53) ? "tc" : "sc";
  return null;
}

function covers(has: Coverage, kind: ScriptKind): boolean {
  if (kind === "latin") return share(has, LATIN_LETTERS) >= 0.9;
  if (kind === "emoji") return has(0x1f600);
  if (CJK.has(kind)) return cjkKind(has) !== null;
  const sample = metaSample(kind);
  return sample ? share(has, sample) >= 0.8 : false;
}

/**
 * Script to store on the record when the cmap disagrees with the name-based guess;
 * `undefined` when the name is already right or the cmap tells us nothing.
 */
export function scriptFromCoverage(has: Coverage | null, family: string): ScriptKind | undefined {
  if (!has) return undefined;
  const named = scriptOf(family);
  if (named !== "latin" && named !== "other" && covers(has, named)) return undefined;
  const latin = covers(has, "latin");
  const scripts = META_KINDS.filter((k) => !SKIP.has(k) && covers(has, k));
  const own = scripts.filter((k) => !LATIN_COMPANIONS.has(k));
  let detected: ScriptKind | undefined;
  if (!latin && covers(has, "emoji")) detected = "emoji";
  else if (own.length && !(latin && own.length >= 3)) detected = own[0];
  else if (cjkKind(has)) detected = cjkKind(has)!;
  else if (latin) detected = "latin";
  else if (scripts.length) detected = scripts[0];
  if (!detected || detected === named) return undefined;
  return detected;
}

export function scriptFromFontBuffer(buffer: ArrayBuffer | Uint8Array, family: string): ScriptKind | undefined {
  return scriptFromCoverage(cmapCoverage(buffer), family);
}
