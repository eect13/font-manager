/** Decode WOFF2 → SFNT so uploads get fvar/OT instead of the glyphCount:0 stub.
 *  Lazy `wawoff2` — not on the 20k TTF hot path. GDI still wants TTF/OTF on Activate. */

export function isWoff2Magic(buffer: ArrayBuffer | Uint8Array): boolean {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return bytes.length >= 4 && bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x32;
}

type Woff2Mod = {
  decompress?: (b: Uint8Array) => Promise<Uint8Array>;
  default?: { decompress?: (b: Uint8Array) => Promise<Uint8Array> };
};

export async function decodeWoff2ToSfnt(buffer: ArrayBuffer | Uint8Array): Promise<ArrayBuffer | null> {
  if (!isWoff2Magic(buffer)) return null;
  try {
    const mod = (await import("wawoff2")) as Woff2Mod;
    const decompress = mod.decompress ?? mod.default?.decompress;
    if (typeof decompress !== "function") return null;
    const input = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const out = await decompress(input);
    if (!out?.byteLength || out.byteLength < 12) return null;
    const copy = new Uint8Array(out.byteLength);
    copy.set(out);
    return copy.buffer;
  } catch {
    return null;
  }
}
