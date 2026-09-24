/** Desktop Rust parser (ttf-parser + sha2). Web keeps sfnt.ts / SubtleCrypto.
 *  Pass Uint8Array — never Array.from (JSON-boxes every byte). */

import { metricsFromTables } from "./metrics";
import { snapAxes } from "./axes";
import type { FontMetrics } from "./types";
import { CMAP_GLYPH_CAP, shouldUseIpcCmap, shouldUseIpcLayout } from "./wasm-parse";

export type NativeGlyph = { cp: number; gid: number; name: string };
export type NativeAxis = { tag: string; name: string; min: number; max: number; def: number };
export type NativeMetrics = {
  upem: number;
  weightClass: number;
  widthClass: number;
  xHeight?: number;
  capHeight?: number;
  panose?: number[];
};
export type NativeLayout = {
  axes: NativeAxis[];
  otFeatures: string[];
  variable: boolean;
  glyphCount: number;
  metrics?: NativeMetrics;
};

export function fontMetricsFromLayout(layout: NativeLayout): FontMetrics | undefined {
  if (!layout.metrics) return undefined;
  return metricsFromTables({
    upem: layout.metrics.upem,
    weightClass: layout.metrics.weightClass,
    widthClass: layout.metrics.widthClass,
    xHeight: layout.metrics.xHeight,
    capHeight: layout.metrics.capHeight,
    panose: layout.metrics.panose,
  });
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const api = await import("@tauri-apps/api/core");
    if (typeof api.isTauri === "function" && !api.isTauri()) return null;
    return await api.invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

function bytesArg(buffer: ArrayBuffer | Uint8Array) {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

function snapLayout(layout: NativeLayout): NativeLayout {
  return { ...layout, axes: layout.axes?.length ? snapAxes(layout.axes) : layout.axes };
}

export async function nativeFamilyCmap(family: string): Promise<NativeGlyph[] | null> {
  const rows = await invoke<NativeGlyph[]>("parse_family_cmap", { family });
  return rows ? rows.slice(0, CMAP_GLYPH_CAP) : null;
}

export async function nativeFamilyLayout(family: string): Promise<NativeLayout | null> {
  const layout = await invoke<NativeLayout>("parse_family_layout", { family });
  return layout ? snapLayout(layout) : null;
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
  if (!shouldUseIpcLayout(buffer.byteLength)) return null;
  const layout = await invoke<NativeLayout>("parse_font_layout", { bytes: bytesArg(buffer) });
  return layout ? snapLayout(layout) : null;
}

export async function nativeLayoutsFromBytes(buffer: ArrayBuffer): Promise<NativeLayout[] | null> {
  if (!shouldUseIpcLayout(buffer.byteLength)) return null;
  const faces = await invoke<NativeLayout[]>("parse_font_layouts", { bytes: bytesArg(buffer) });
  return faces?.map(snapLayout) ?? null;
}

export async function nativeCmapFromBytes(buffer: ArrayBuffer): Promise<NativeGlyph[] | null> {
  if (!shouldUseIpcCmap(buffer.byteLength)) return null;
  const rows = await invoke<NativeGlyph[]>("parse_font_cmap", { bytes: bytesArg(buffer) });
  return rows?.length ? rows.slice(0, CMAP_GLYPH_CAP) : null;
}

export async function nativeHashBytes(buffer: ArrayBuffer): Promise<string | null> {
  if (buffer.byteLength > 400_000) return null;
  return invoke<string>("hash_bytes", { bytes: bytesArg(buffer) });
}

export async function nativeHashPath(path: string): Promise<string | null> {
  return invoke<string>("hash_font_path", { path });
}

export type NativeIndexFace = {
  path: string;
  fileName: string;
  fileSize: number;
  family: string;
  fullName: string;
  weight: number;
  italic: boolean;
  variable: boolean;
  axes: NativeAxis[];
  metrics?: NativeMetrics;
  checksum: string;
  glyphCount: number;
  otFeatures: string[];
  /** File mtime in ms. 0 when the OS did not report one. */
  modifiedMs?: number;
};

/** Desktop watch/20k: ttf-parser on disk. No File buffers in JS. WOFF2 omitted. */
export async function indexFontPaths(paths: string[]): Promise<NativeIndexFace[]> {
  if (!paths.length) return [];
  const rows = await invoke<NativeIndexFace[]>("index_font_paths", { paths });
  if (!rows?.length) return [];
  return rows.map((row) => ({
    ...row,
    axes: row.axes?.length ? snapAxes(row.axes) : [],
  }));
}

export async function nativeDiffBytes(
  left: Uint8Array,
  right: Uint8Array,
): Promise<{ near: boolean; diffs: number } | null> {
  if (left.byteLength > 8_000_000 || right.byteLength > 8_000_000) return null;
  return invoke<{ near: boolean; diffs: number }>("diff_font_bytes", {
    left: bytesArg(left),
    right: bytesArg(right),
  });
}
