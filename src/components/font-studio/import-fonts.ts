import { toast } from "sonner";
import { folderNameFromFiles, isFontFile } from "@/lib/fonts/fs-drop";
import { useFontStore } from "@/lib/fonts/store";

let inFlight = false;

export async function runFontImport(
  list: FileList | File[],
  opts?: { collectionId?: string; collectionName?: string },
) {
  if (inFlight || useFontStore.getState().uploadBusy) return;
  const files = Array.from(list).filter(isFontFile);
  if (!files.length) {
    toast.error("No TTF, OTF, WOFF, WOFF2, or TTC files found");
    return;
  }

  const collectionName =
    opts?.collectionName ??
    (opts?.collectionId ? undefined : folderNameFromFiles(files));

  inFlight = true;
  try {
    const result = await useFontStore.getState().importFiles(files, {
      collectionId: opts?.collectionId,
      collectionName,
    });

    const folder =
      result.collectionId
        ? useFontStore.getState().collections.find((c) => c.id === result.collectionId)
        : undefined;

    if (result.added) {
      toast.success(
        folder
          ? `Added ${result.added} to ${folder.name}`
          : `Added ${result.added} typeface${result.added === 1 ? "" : "s"}`,
      );
    }
    if (result.duplicates) {
      toast.message(
        `${result.duplicates} duplicate file${result.duplicates === 1 ? "" : "s"} skipped`,
      );
    }
    if (result.failed) {
      toast.error(`${result.failed} file${result.failed === 1 ? "" : "s"} could not be read`);
    }
    return result;
  } finally {
    inFlight = false;
  }
}
