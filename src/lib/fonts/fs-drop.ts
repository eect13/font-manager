const ACCEPT = [".ttf", ".otf", ".woff", ".woff2", ".ttc", ".otc"];

export function fontMime(name: string) {
  const n = name.toLowerCase();
  if (n.endsWith(".woff2")) return "font/woff2";
  if (n.endsWith(".woff")) return "font/woff";
  if (n.endsWith(".otf")) return "font/otf";
  if (n.endsWith(".ttc")) return "font/collection";
  return "font/ttf";
}

export function isFontFile(file: File) {
  const name = file.name.toLowerCase();
  if (name.startsWith(".") || name.startsWith("._")) return false;
  return ACCEPT.some((ext) => name.endsWith(ext));
}

export function folderNameFromFiles(files: File[]): string | undefined {
  const tops = files
    .map((file) => file.webkitRelativePath?.split("/")[0])
    .filter((part): part is string => Boolean(part));
  if (!tops.length) return undefined;
  const first = tops[0];
  return tops.every((part) => part === first) ? first : undefined;
}

type FsEntry = FileSystemEntry & {
  isFile: boolean;
  isDirectory: boolean;
  file?: (ok: (file: File) => void, err?: (e: Error) => void) => void;
  createReader?: () => FileSystemDirectoryReader;
};

async function walk(entry: FsEntry, files: File[], prefix: string) {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file!(resolve, reject);
    });
    const rel = prefix ? `${prefix}/${file.name}` : file.name;
    if (rel !== file.webkitRelativePath) {
      const tagged = new File([file], file.name, { type: file.type || fontMime(file.name) });
      Object.defineProperty(tagged, "webkitRelativePath", { value: rel });
      files.push(tagged);
    } else {
      files.push(file);
    }
    return;
  }
  if (entry.isDirectory && entry.createReader) {
    const next = prefix ? `${prefix}/${entry.name}` : entry.name;
    const reader = entry.createReader();
    const readBatch = async (): Promise<void> => {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (!batch.length) return;
      for (const child of batch) await walk(child as FsEntry, files, next);
      await readBatch();
    };
    await readBatch();
  }
}

export async function filesFromDataTransfer(
  dt: DataTransfer,
): Promise<{ files: File[]; folderName?: string }> {
  const items = Array.from(dt.items ?? []);
  const entries = items
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));

  if (entries.length) {
    const dirs = entries.filter((entry) => entry.isDirectory);
    const folderName =
      dirs.length === 1 && entries.every((entry) => entry.isDirectory)
        ? dirs[0]?.name
        : undefined;
    const files: File[] = [];
    for (const entry of entries) {
      await walk(entry as FsEntry, files, "");
    }
    return { files, folderName: folderName || folderNameFromFiles(files) };
  }

  const files = Array.from(dt.files ?? []);
  return { files, folderName: folderNameFromFiles(files) };
}
