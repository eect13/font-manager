/** Desktop Rust parser (ttf-parser + sha2). Web keeps opentype.js / SubtleCrypto. */

export type NativeGlyph = { cp: number; gid: number; name: string };
export type NativeAxis = { tag: string; name: string; min: number; max: number; def: number };
export type NativeLayout = {
  axes: NativeAxis[];
  otFeatures: string[];
  variable: boolean;
  glyphCount: number;
};

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const api = await import("@tauri-apps/api/core");
    if (typeof api.isTauri === "function" && !api.isTauri()) return null;
    return await api.invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

export async function nativeFamilyCmap(family: string): Promise<NativeGlyph[] | null> {
  return invoke<NativeGlyph[]>("parse_family_cmap", { family });
}

export async function nativeFamilyLayout(family: string): Promise<NativeLayout | null> {
  return invoke<NativeLayout>("parse_family_layout", { family });
}

export async function nativeLayoutFromBytes(buffer: ArrayBuffer): Promise<NativeLayout | null> {
  const faces = await nativeLayoutsFromBytes(buffer);
  if (faces?.length) {
    return faces.reduce((best, face) =>
      face.glyphCount > best.glyphCount || (face.glyphCount === best.glyphCount && face.axes.length > best.axes.length)
        ? face
        : best,
    );
  }
  if (buffer.byteLength > 180_000) return null;
  return invoke<NativeLayout>("parse_font_layout", { bytes: Array.from(new Uint8Array(buffer)) });
}

export async function nativeLayoutsFromBytes(buffer: ArrayBuffer): Promise<NativeLayout[] | null> {
  if (buffer.byteLength > 180_000) return null;
  return invoke<NativeLayout[]>("parse_font_layouts", { bytes: Array.from(new Uint8Array(buffer)) });
}

export async function nativeCmapFromBytes(buffer: ArrayBuffer): Promise<NativeGlyph[] | null> {
  if (buffer.byteLength > 180_000) return null;
  const rows = await invoke<NativeGlyph[]>("parse_font_cmap", { bytes: Array.from(new Uint8Array(buffer)) });
  return rows?.length ? rows : null;
}

export async function nativeHashBytes(buffer: ArrayBuffer): Promise<string | null> {
  if (buffer.byteLength > 400_000) return null;
  return invoke<string>("hash_bytes", { bytes: Array.from(new Uint8Array(buffer)) });
}

export async function nativeHashPath(path: string): Promise<string | null> {
  return invoke<string>("hash_font_path", { path });
}

export async function nativeDiffBytes(
  left: Uint8Array,
  right: Uint8Array,
): Promise<{ near: boolean; diffs: number } | null> {
  if (left.byteLength > 8_000_000 || right.byteLength > 8_000_000) return null;
  return invoke<{ near: boolean; diffs: number }>("diff_font_bytes", {
    left: Array.from(left),
    right: Array.from(right),
  });
}