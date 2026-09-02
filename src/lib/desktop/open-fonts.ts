import { fontMime, isFontFile } from "@/lib/fonts/fs-drop";

const FONT_EXT = ["ttf", "otf", "woff", "woff2", "ttc"];

function joinPath(dir: string, name: string) {
  if (!dir) return name;
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${sep}${name}`;
}

function baseName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[/\\]/).pop() ?? path;
}

export function forbiddenWatchReason(dir: string): string | null {
  const n = dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (n.includes("/windows/fonts") || /(^|\/)windows\/fonts$/.test(n)) {
    return "C:\\Windows\\Fonts is view-only (System). Do not watch it.";
  }
  if (n.endsWith("/documents/font manager") || n.endsWith("/documents/font%20manager")) {
    return "Documents\\Font Manager is the session cache. The library already owns those files.";
  }
  return null;
}

function bytesToFile(bytes: Uint8Array, name: string, relativePath?: string): File {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const file = new File([copy], name, { type: fontMime(name) });
  if (relativePath) {
    Object.defineProperty(file, "webkitRelativePath", { value: relativePath.replace(/\\/g, "/") });
  }
  return file;
}

let desktopCached: boolean | undefined;

function desktopHost() {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "tauri.localhost" || h.endsWith(".tauri.localhost");
}

export function isDesktopShellSync() {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown; isTauri?: boolean };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__ || w.isTauri || desktopHost());
}

export async function inDesktopShell(): Promise<boolean> {
  if (desktopCached === true || isDesktopShellSync()) {
    desktopCached = true;
    return true;
  }
  try {
    const api = await import("@tauri-apps/api/core");
    if (typeof api.isTauri === "function" && api.isTauri()) {
      desktopCached = true;
      return true;
    }
  } catch {
    /* website bundle */
  }
  // Do not cache false — Tauri internals can appear after the first paint.
  return false;
}

async function fileFromPath(
  readFile: (path: string) => Promise<Uint8Array>,
  path: string,
  relativePath?: string,
): Promise<File | null> {
  const name = baseName(path);
  const fake = { name } as File;
  if (!isFontFile(fake)) return null;
  const bytes = await readFile(path);
  return bytesToFile(bytes, name, relativePath);
}

export async function pickFontFiles(): Promise<File[] | "web"> {
  if (!(await inDesktopShell())) return "web";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const selected = await open({
    multiple: true,
    title: "Add font files",
    filters: [{ name: "Fonts", extensions: FONT_EXT }],
  });
  if (!selected) return [];
  const paths = Array.isArray(selected) ? selected : [selected];
  const files: File[] = [];
  for (const path of paths) {
    try {
      const file = await fileFromPath(readFile, path);
      if (file) files.push(file);
    } catch {
      /* scoped path or unreadable */
    }
  }
  return files;
}

export async function pickFontFolder(): Promise<{ files: File[]; name: string } | "web" | null> {
  if (!(await inDesktopShell())) return "web";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const { readDir, readFile } = await import("@tauri-apps/plugin-fs");
  const dir = await open({
    directory: true,
    multiple: false,
    recursive: true,
    title: "Add a folder of fonts",
  });
  if (!dir || Array.isArray(dir)) return null;
  const files: File[] = [];
  const rootName = baseName(dir);
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop() as string;
    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
    try {
      entries = await readDir(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = joinPath(current, entry.name);
      if (entry.isDirectory) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile) continue;
      try {
        const tail = path.slice(dir.length).replace(/^[/\\]+/, "");
        const relative = `${rootName}/${tail}`.replace(/\\/g, "/");
        const file = await fileFromPath(readFile, path, relative);
        if (file) files.push(file);
      } catch {
        /* skip unreadable */
      }
    }
  }
  return { files, name: rootName };
}

export async function pickWatchFolder(): Promise<
  | { path: string; name: string; files: File[]; originPaths: string[]; blocked?: string }
  | "web"
  | null
> {
  if (!(await inDesktopShell())) return "web";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = await open({
    directory: true,
    multiple: false,
    recursive: true,
    title: "Watch a folder of fonts",
  });
  if (!dir || Array.isArray(dir)) return null;
  const blocked = forbiddenWatchReason(dir);
  if (blocked) {
    return { path: dir, name: baseName(dir), files: [], originPaths: [], blocked };
  }
  const listed = await listWatchFolder(dir);
  const scanned = await readWatchFiles(dir, listed.paths);
  return { path: dir, name: baseName(dir), ...scanned };
}

export type WatchListing = {
  paths: string[];
  sizes: number[];
  mtimes: number[];
};

export async function listWatchFolder(dir: string): Promise<WatchListing> {
  const empty: WatchListing = { paths: [], sizes: [], mtimes: [] };
  if (!(await inDesktopShell())) return empty;
  const { readDir, stat } = await import("@tauri-apps/plugin-fs");
  const paths: string[] = [];
  const sizes: number[] = [];
  const mtimes: number[] = [];
  const stack: { path: string; depth: number }[] = [{ path: dir, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > 8) continue;
    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
    try {
      entries = await readDir(current.path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = joinPath(current.path, entry.name);
      if (entry.isDirectory) {
        if (!entry.name.startsWith(".")) stack.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile) continue;
      if (!isFontFile({ name: entry.name } as File)) continue;
      try {
        const info = await stat(path);
        paths.push(path);
        sizes.push(Number(info.size) || 0);
        mtimes.push(info.mtime ? info.mtime.getTime() : 0);
      } catch {
        paths.push(path);
        sizes.push(0);
        mtimes.push(0);
      }
    }
  }
  return { paths, sizes, mtimes };
}

export async function readWatchFiles(
  dir: string,
  originPaths: string[],
): Promise<{ files: File[]; originPaths: string[] }> {
  if (!(await inDesktopShell()) || !originPaths.length) return { files: [], originPaths: [] };
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const files: File[] = [];
  const kept: string[] = [];
  const rootName = baseName(dir);
  for (const path of originPaths) {
    try {
      const tail = path.slice(dir.length).replace(/^[/\\]+/, "");
      const relative = `${rootName}/${tail}`.replace(/\\/g, "/");
      const file = await fileFromPath(readFile, path, relative);
      if (file) {
        files.push(file);
        kept.push(path);
      }
    } catch {
      /* skip */
    }
  }
  return { files, originPaths: kept };
}

export async function scanWatchFolder(
  dir: string,
): Promise<{ files: File[]; originPaths: string[] }> {
  const listed = await listWatchFolder(dir);
  return readWatchFiles(dir, listed.paths);
}
