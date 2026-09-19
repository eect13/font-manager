import type { FontRecord } from "./types";
import { idbGet, idbPut } from "./idb";

/** IndexedDB key for upload catalog metadata. File blobs stay on their own keys. */
export const LOCAL_FONTS_META_ID = "meta:local-fonts";

export function slimLocalFont(font: FontRecord): FontRecord {
  return {
    id: font.id,
    family: font.family,
    fullName: font.fullName,
    source: "local",
    category: font.category,
    weights: font.weights?.length ? font.weights : [400],
    italic: Boolean(font.italic),
    variable: Boolean(font.variable),
    catalogVariable: font.catalogVariable,
    axes: font.axes,
    instances: font.instances,
    tags: font.tags ?? [],
    popularity: font.popularity ?? 9999,
    license: font.license,
    licenseName: font.licenseName,
    licenseUserSet: font.licenseUserSet,
    fileName: font.fileName,
    fileSize: font.fileSize,
    checksum: font.checksum,
    originPath: font.originPath,
    cssFamily: font.cssFamily,
    colorKind: font.colorKind,
    metrics: font.metrics,
  };
}

export async function saveLocalFontsMeta(fonts: FontRecord[]): Promise<void> {
  const slim = fonts.map(slimLocalFont);
  await idbPut(LOCAL_FONTS_META_ID, new Blob([JSON.stringify(slim)], { type: "application/json" }));
}

export async function loadLocalFontsMeta(): Promise<FontRecord[] | null> {
  try {
    const blob = await idbGet(LOCAL_FONTS_META_ID);
    if (!blob || typeof blob.text !== "function") return null;
    const parsed = JSON.parse(await blob.text()) as unknown;
    if (!Array.isArray(parsed)) return null;
    const fonts = parsed.filter(
      (row): row is FontRecord =>
        Boolean(row) &&
        typeof row === "object" &&
        typeof (row as FontRecord).id === "string" &&
        typeof (row as FontRecord).family === "string",
    );
    return fonts;
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pending: FontRecord[] | null = null;

export function scheduleSaveLocalFontsMeta(fonts: FontRecord[]) {
  pending = fonts;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    const next = pending;
    pending = null;
    if (!next) return;
    void saveLocalFontsMeta(next).catch(() => undefined);
  }, 400);
}

export function pickLocalFontsPersist(idb: FontRecord[] | null, fromLs: FontRecord[]): FontRecord[] {
  const a = idb ?? [];
  if (a.length >= fromLs.length) return a.length ? a : fromLs;
  return fromLs;
}
