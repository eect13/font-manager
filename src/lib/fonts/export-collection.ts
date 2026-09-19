import { toast } from "sonner";
import { inDesktopShell } from "../desktop/open-fonts";
import { idbGet } from "./idb";
import { buildStoreZip } from "./pack-zip";
import { collectFolderFontIds, collectFolderTreeIds, collectionIsWatched, findFont, useFontStore } from "./store";
import type { FontRecord } from "./types";
import { parseCollectionSync, type CollectionSyncV1 } from "./collection-sync";

export { parseCollectionSync, type CollectionSyncV1 } from "./collection-sync";

function safeName(raw: string, used: Set<string>): string {
  const base = (raw || "font.ttf").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const dot = base.lastIndexOf(".");
    name = dot > 0 ? `${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${base}-${n}`;
    n += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

async function bytesFor(font: FontRecord): Promise<Uint8Array | null> {
  if (font.originPath) {
    try {
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      const res = await fetch(convertFileSrc(font.originPath));
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch {
      /* IDB / Documents */
    }
  }
  const blob = await idbGet(font.id);
  if (blob) return new Uint8Array(await blob.arrayBuffer());
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const path = await invoke<string>("read_family_font", { family: font.family });
    if (path) return new Uint8Array(await readFile(path));
  } catch {
    /* catalog-only — not on disk */
  }
  return null;
}

export async function exportCollectionZip(collectionId: string): Promise<void> {
  const { collections, localFonts, googleFonts } = useFontStore.getState();
  const folder = collections.find((c) => c.id === collectionId);
  if (!folder) return;
  const ids = collectFolderFontIds(collections, collectionId);
  const used = new Set<string>();
  const entries: { name: string; data: Uint8Array }[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const font = findFont(id, localFonts, googleFonts);
    if (!font) continue;
    const data = await bytesFor(font);
    if (!data?.byteLength) {
      missing.push(font.family);
      continue;
    }
    const name = safeName(font.fileName || `${font.family}.ttf`, used);
    entries.push({ name, data });
  }
  const list = `# ${folder.name}\n# Font Manager collection export\n${[...ids]
    .map((id) => findFont(id, localFonts, googleFonts)?.family)
    .filter(Boolean)
    .join("\n")}\n`;
  entries.push({ name: "fonts.txt", data: new TextEncoder().encode(list) });
  if (entries.length <= 1) {
    toast.message("Nothing to pack", {
      description: "Activate or download those families first so TTF files exist.",
    });
    return;
  }
  const zip = buildStoreZip(entries);
  const fileName = `${folder.name.replace(/[<>:"/\\|?*]+/g, " ").trim() || "collection"}.zip`;
  const zipAb = new ArrayBuffer(zip.byteLength);
  new Uint8Array(zipAb).set(zip);
  if (await inDesktopShell()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const dest = await save({ defaultPath: fileName, filters: [{ name: "Zip", extensions: ["zip"] }] });
      if (!dest) return;
      await writeFile(dest, zip);
      toast.success(`Packed ${entries.length - 1} files`, {
        description: missing.length ? `${missing.length} catalog-only skipped` : dest,
      });
      return;
    } catch {
      /* fall through to download */
    }
  }
  const url = URL.createObjectURL(new Blob([zipAb], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  toast.success(`Packed ${entries.length - 1} files`);
}

function familyKey(name: string) {
  return name.trim().toLowerCase();
}

function virtualCollections(ids?: string[]) {
  const { collections } = useFontStore.getState();
  const wanted = ids?.length ? new Set(ids) : null;
  return collections.filter((c) => {
    if (collectionIsWatched(collections, c.id)) return false;
    if (wanted && !wanted.has(c.id)) return false;
    return true;
  });
}

function pickFontByFamily(family: string): FontRecord | undefined {
  const { localFonts, googleFonts, systemFonts } = useFontStore.getState();
  const key = familyKey(family);
  const google = googleFonts.find((f) => familyKey(f.family) === key);
  if (google) return google;
  const local = localFonts.find((f) => familyKey(f.family) === key);
  if (local) return local;
  return systemFonts.find((f) => familyKey(f.family) === key);
}

export function buildCollectionSync(collectionId?: string): CollectionSyncV1 {
  const { collections, localFonts, googleFonts, favorites, customTags } = useFontStore.getState();
  const treeIds = collectionId ? collectFolderTreeIds(collections, collectionId) : undefined;
  const rows = virtualCollections(treeIds);
  const familyOf = (id: string) => findFont(id, localFonts, googleFonts)?.family;
  const out: CollectionSyncV1 = {
    v: 1,
    app: "font-manager",
    exportedAt: Date.now(),
    collections: rows.map((c) => ({
      name: c.name,
      parent: c.parentId ? collections.find((p) => p.id === c.parentId)?.name ?? null : null,
      families: c.fontIds.map((id) => familyOf(id)).filter((n): n is string => Boolean(n)),
    })),
  };
  if (!collectionId) {
    const favNames = favorites.map((id) => familyOf(id)).filter((n): n is string => Boolean(n));
    if (favNames.length) out.favorites = Array.from(new Set(favNames));
    const tags: Record<string, string[]> = {};
    for (const [id, list] of Object.entries(customTags)) {
      const name = familyOf(id);
      if (name && list.length) tags[name] = list;
    }
    if (Object.keys(tags).length) out.tags = tags;
  }
  return out;
}

export function applyCollectionSync(sync: CollectionSyncV1): {
  collections: number;
  linked: number;
  missing: string[];
} {
  const missing: string[] = [];
  const seenMissing = new Set<string>();
  let linked = 0;
  const pending = sync.collections.slice();
  let guard = pending.length + 2;
  while (pending.length && guard > 0) {
    guard -= 1;
    const row = pending.shift()!;
    const store = useFontStore.getState();
    const parentId = row.parent
      ? store.collections.find(
          (c) => familyKey(c.name) === familyKey(row.parent!) && !collectionIsWatched(store.collections, c.id),
        )?.id ?? null
      : null;
    if (row.parent && !parentId) {
      pending.push(row);
      continue;
    }
    const existing = store.collections.find(
      (c) =>
        familyKey(c.name) === familyKey(row.name) &&
        (c.parentId ?? null) === parentId &&
        !collectionIsWatched(store.collections, c.id),
    );
    const id = existing?.id ?? store.addCollection(row.name, parentId);
    for (const family of row.families) {
      const font = pickFontByFamily(family);
      if (!font) {
        if (!seenMissing.has(familyKey(family))) {
          seenMissing.add(familyKey(family));
          missing.push(family);
        }
        continue;
      }
      useFontStore.getState().addToCollection(id, font.id);
      linked += 1;
    }
  }
  const after = useFontStore.getState();
  if (sync.favorites?.length) {
    const fav = new Set(after.favorites);
    for (const family of sync.favorites) {
      const font = pickFontByFamily(family);
      if (font && !fav.has(font.id)) after.toggleFavorite(font.id);
    }
  }
  if (sync.tags) {
    for (const [family, list] of Object.entries(sync.tags)) {
      const font = pickFontByFamily(family);
      if (!font) continue;
      for (const tag of list) after.addTag(font.id, tag);
    }
  }
  return { collections: sync.collections.length, linked, missing };
}

async function writeJsonFile(fileName: string, text: string): Promise<boolean> {
  if (await inDesktopShell()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const dest = await save({
        defaultPath: fileName,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!dest) return false;
      await writeTextFile(dest, text);
      toast.success("Collection JSON saved", { description: dest });
      return true;
    } catch {
      /* browser download */
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  toast.success("Collection JSON saved");
  return true;
}

export async function exportCollectionJson(collectionId?: string): Promise<void> {
  const sync = buildCollectionSync(collectionId);
  if (!sync.collections.length) {
    toast.message("Nothing to export", { description: "Create a collection first. Watched folders stay on disk." });
    return;
  }
  const folder = collectionId ? useFontStore.getState().collections.find((c) => c.id === collectionId) : undefined;
  const fileName = `${(folder?.name || "Font-Manager-collections").replace(/[<>:"/\\|?*]+/g, " ").trim()}.json`;
  await writeJsonFile(fileName, `${JSON.stringify(sync, null, 2)}\n`);
}

export async function importCollectionJson(): Promise<void> {
  let text = "";
  if (await inDesktopShell()) {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path || Array.isArray(path)) return;
      text = await readTextFile(path);
    } catch {
      text = "";
    }
  }
  if (!text) {
    text = await new Promise<string>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve("");
        void file.text().then(resolve, () => resolve(""));
      };
      input.click();
    });
  }
  if (!text) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    toast.error("Not valid JSON");
    return;
  }
  const sync = parseCollectionSync(parsed);
  if (!sync) {
    toast.error("Not a Font Manager collection file");
    return;
  }
  const result = applyCollectionSync(sync);
  toast.success(
    `Imported ${result.collections.toLocaleString()} collection${result.collections === 1 ? "" : "s"}`,
    {
      description: result.missing.length
        ? `${result.linked.toLocaleString()} linked · ${result.missing.length} families not in this library`
        : `${result.linked.toLocaleString()} families linked`,
    },
  );
}

