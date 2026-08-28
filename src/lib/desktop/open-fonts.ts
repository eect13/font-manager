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

function bytesToFile(bytes: Uint8Array, name: string, relativePath?: string): File {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const file = new File([copy], name, { type: fontMime(name) });
  if (relativePath) {
    Object.defineProperty(file, "webkitRelativePath", { value: relativePath.replace(/\\/g, "/") });
  }
  return file;
}

export async function inDesktopShell(): Promise<boolean> {
  try {
    const api = await import("@tauri-apps/api/core");
    if (typeof api.isTauri === "function") return api.isTauri();
  } catch {
    /* web bundle */
  }
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
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
  { path: string; name: string; files: File[]; originPaths: string[] } | "web" | null
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
  const scanned = await scanWatchFolder(dir);
  return { path: dir, name: baseName(dir), ...scanned };
}

export async function scanWatchFolder(
  dir: string,
): Promise<{ files: File[]; originPaths: string[] }> {
  if (!(await inDesktopShell())) return { files: [], originPaths: [] };
  const { readDir, readFile } = await import("@tauri-apps/plugin-fs");
  const files: File[] = [];
  const originPaths: string[] = [];
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
        if (file) {
          files.push(file);
          originPaths.push(path);
        }
      } catch {
        /* skip */
      }
    }
  }
  return { files, originPaths };
}
