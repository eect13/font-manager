import { toast } from "sonner";
import {
  forbiddenWatchReason,
  inDesktopShell,
  listWatchFolder,
  pickWatchFolder,
  readWatchFiles,
} from "@/lib/desktop/open-fonts";
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
let inflight = false;
let queued = false;
let started = false;
const unwatchers = new Map<string, () => void>();

function signature(paths: string[], sizes: number[], mtimes: number[]) {
  return paths
    .map((path, i) => `${norm(path)}:${sizes[i] ?? 0}:${mtimes[i] ?? 0}`)
    .sort()
    .join("|");
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
  if (picked.blocked) {
    toast.message("That folder cannot be watched", { description: picked.blocked });
    return;
  }
  const blocked = forbiddenWatchReason(picked.path);
  if (blocked) {
    toast.message("That folder cannot be watched", { description: blocked });
    return;
  }
  const store = useFontStore.getState();
  const existing = store.collections.find((c) => c.watchPath && norm(c.watchPath) === norm(picked.path));
  const id = existing?.id ?? store.addCollection(picked.name);
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
  void bindNativeWatch();
  void refreshWatchedFolders();
}

export async function refreshWatchedFolders(): Promise<void> {
  if (inflight) {
    queued = true;
    return;
  }
  if (!(await inDesktopShell())) return;
  inflight = true;
  try {
    const { collections, localFonts, importFiles, removeLocalFont } = useFontStore.getState();
    const watched = collections.filter((c) => c.watchPath);
    if (!watched.length) return;
    const allOrigins: string[] = [];
    const allSizes: number[] = [];
    const allMtimes: number[] = [];
    for (const folder of watched) {
      const root = folder.watchPath!;
      const blocked = forbiddenWatchReason(root);
      if (blocked) continue;
      const listed = await listWatchFolder(root);
      allOrigins.push(...listed.paths);
      allSizes.push(...listed.sizes);
      allMtimes.push(...listed.mtimes);
      const known = localFonts.filter((f) => f.originPath && underWatch(f.originPath, root));
      const knownByPath = new Map(known.map((f) => [norm(f.originPath!), f]));
      const freshPaths: string[] = [];
      for (let i = 0; i < listed.paths.length; i += 1) {
        const origin = listed.paths[i]!;
        const prev = knownByPath.get(norm(origin));
        if (prev && (prev.fileSize ?? 0) === listed.sizes[i]) continue;
        if (prev) await removeLocalFont(prev.id);
        freshPaths.push(origin);
      }
      if (freshPaths.length) {
        const scanned = await readWatchFiles(root, freshPaths);
        if (scanned.files.length) {
          await importFiles(scanned.files, {
            collectionId: folder.id,
            collectionName: folder.name,
            originPaths: scanned.originPaths,
          });
        }
      }
    }
    const sig = signature(allOrigins, allSizes, allMtimes);
    if (sig === lastSig) return;
    lastSig = sig;
    const live = new Set(allOrigins.map(norm));
    const stale = useFontStore
      .getState()
      .localFonts.filter(
        (f) =>
          f.originPath &&
          watched.some((w) => underWatch(f.originPath!, w.watchPath!)) &&
          !live.has(norm(f.originPath)),
      );
    for (const font of stale) {
      await removeLocalFont(font.id);
    }
  } finally {
    inflight = false;
    if (queued) {
      queued = false;
      void refreshWatchedFolders();
    }
  }
}

async function bindNativeWatch() {
  if (!(await inDesktopShell())) return;
  const watched = useFontStore
    .getState()
    .collections.filter((c) => c.watchPath && !forbiddenWatchReason(c.watchPath));
  const live = new Set(watched.map((c) => norm(c.watchPath!)));
  for (const [key, stop] of unwatchers) {
    if (live.has(key)) continue;
    try {
      stop();
    } catch {
      /* ignore */
    }
    unwatchers.delete(key);
  }
  if (!watched.length) return;
  try {
    const { watch } = await import("@tauri-apps/plugin-fs");
    let debounce = 0;
    const kick = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void refreshWatchedFolders(), 280);
    };
    for (const folder of watched) {
      const key = norm(folder.watchPath!);
      if (unwatchers.has(key)) continue;
      try {
        const stop = await watch(folder.watchPath!, () => kick(), {
          delayMs: 280,
          recursive: true,
        });
        unwatchers.set(key, stop);
      } catch {
        /* installer without fs watch — poll instead */
      }
    }
  } catch {
    /* website bundle */
  }
}

export function startWatchPolling() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.setTimeout(() => {
    void bindNativeWatch();
    void refreshWatchedFolders();
    const tick = () => {
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      const native = unwatchers.size > 0;
      const ms = hidden ? 30_000 : native ? 20_000 : 8_000;
      window.clearInterval(pollTimer);
      pollTimer = window.setInterval(() => void refreshWatchedFolders(), ms);
    };
    tick();
    document.addEventListener("visibilitychange", () => {
      tick();
      if (document.visibilityState === "visible") void refreshWatchedFolders();
    });
  }, 8000);
}
