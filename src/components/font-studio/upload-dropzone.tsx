import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { filesFromDataTransfer } from "@/lib/fonts/fs-drop";
import { useFontStore } from "@/lib/fonts/store";
import { cn } from "@/lib/utils";
import { runFontImport } from "./import-fonts";

function isOsFileDrag(e: DragEvent) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  const types = Array.from(dt.types);
  if (types.includes("application/x-font-id") || types.includes("application/x-folder-id")) return false;
  return types.includes("Files");
}

export function UploadDropzone({ children }: { children: ReactNode }) {
  const uploadBusy = useFontStore((s) => s.uploadBusy);
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    function clear() {
      depth.current = 0;
      setOver(false);
    }
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    if (!isOsFileDrag(e) || !e.dataTransfer) return;
    const { files, folderName } = await filesFromDataTransfer(e.dataTransfer);
    if (files.length) void runFontImport(files, { collectionName: folderName });
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (!isOsFileDrag(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!isOsFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!isOsFileDrag(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      {children}
      {(over || uploadBusy) && (
        <div
          className={cn(
            "pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border border-dashed bg-background/80",
            over ? "border-primary" : "border-border",
          )}
        >
          <p className="font-heading text-2xl">
            {uploadBusy ? "Reading fonts…" : "Drop files or a folder"}
          </p>
        </div>
      )}
    </div>
  );
}
