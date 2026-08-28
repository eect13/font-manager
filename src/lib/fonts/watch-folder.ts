import { toast } from "sonner";
import { inDesktopShell, pickWatchFolder, scanWatchFolder } from "@/lib/desktop/open-fonts";
import { useFontStore } from "./store";

function norm(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function underWatch(origin: string, root: string) {
  const a = norm(origin);
  const b = norm(root);
  return a === b || a.startsWith(`${b}/`);
}

let pollTimer = 0;
let lastSig = "";

function signature(paths: string[]) {
  return paths.slice().sort().join("|");
}

export async function addWatchedFolder(): Promise<void> {
  const picked = await pickWatchFolder();
  if (picked === "web") {
    toast.message("Watch folders need the desktop app", {
      description: "Build with deploy.bat. In the browser, use Folder to import a copy instead.",
    });
    return;
  }
  if (!picked) return;
  const store = useFontStore.getState();
  const existing = store.collections.find((c) => c.watchPath && norm(c.watchPath) === norm(picked.path));
  const id =
    existing?.id ??
    store.addCollection(picked.name);
  store.setCollectionWatch(id, picked.path, existing?.autoActivate ?? true);
  store.setScope(`collection:${id}`);
  if (picked.files.length) {
    const result = await store.importFiles(picked.files, {
      collectionId: id,
      collectionName: picked.name,
      originPaths: picked.originPaths,
    });
    toast.success(`Watching ${picked.name}`, {
      description: `${result.added.toLocaleString()} typeface${result.added === 1 ? "" : "s"} stay in that folder. Auto-activate is on.`,
    });
  } else {
    toast.message(`Watching ${picked.name}`, {
      description: "No font files yet. Drop TTF/OTF/WOFF into that folder; we pick them up.",
    });
  }
  lastSig = "";
  void refreshWatchedFolders();
}

export async function refreshWatchedFolders(): Promise<void> {
  if (!(await inDesktopShell())) return;
  const { collections, localFonts, importFiles, removeLocalFont } = useFontStore.getState();
  const watched = collections.filter((c) => c.watchPath);
  if (!watched.length) return;
  const allOrigins: string[] = [];
  for (const folder of watched) {
    const scanned = await scanWatchFolder(folder.watchPath!);
    allOrigins.push(...scanned.originPaths);
    const known = new Set(
      localFonts.filter((f) => f.originPath && underWatch(f.originPath, folder.watchPath!)).map((f) => norm(f.originPath!)),
    );
    const freshFiles: File[] = [];
    const freshPaths: string[] = [];
    for (let i = 0; i < scanned.files.length; i += 1) {
      const origin = scanned.originPaths[i]!;
      if (known.has(norm(origin))) continue;
      freshFiles.push(scanned.files[i]!);
      freshPaths.push(origin);
    }
    if (freshFiles.length) {
      await importFiles(freshFiles, {
        collectionId: folder.id,
        collectionName: folder.name,
        originPaths: freshPaths,
      });
    }
  }
  const sig = signature(allOrigins);
  if (sig === lastSig) return;
  lastSig = sig;
  const live = new Set(allOrigins.map(norm));
  const stale = useFontStore
    .getState()
    .localFonts.filter((f) => f.originPath && watched.some((w) => underWatch(f.originPath!, w.watchPath!)) && !live.has(norm(f.originPath)));
  for (const font of stale) {
    await removeLocalFont(font.id);
  }
}

export function startWatchPolling() {
  if (pollTimer || typeof window === "undefined") return;
  void refreshWatchedFolders();
  pollTimer = window.setInterval(() => void refreshWatchedFolders(), 12_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshWatchedFolders();
  });
}
