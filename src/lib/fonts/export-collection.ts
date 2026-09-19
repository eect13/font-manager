import { toast } from "sonner";
import { inDesktopShell } from "../desktop/open-fonts";
import { idbGet } from "./idb";
import { buildStoreZip } from "./pack-zip";
import { collectFolderFontIds, findFont, useFontStore } from "./store";
import type { FontRecord } from "./types";

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
