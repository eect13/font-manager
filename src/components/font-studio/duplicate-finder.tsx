import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/fonts/hash";
import { findDuplicates, useFontStore } from "@/lib/fonts/store";
import type { DuplicateGroup } from "@/lib/fonts/types";

function reasonLabel(group: DuplicateGroup) {
  if (group.reason === "checksum" || group.diffBytes === 0) return "Identical file";
  if (group.reason === "binary") {
    const n = group.diffBytes ?? 0;
    return `Same size — ${n.toLocaleString()} byte${n === 1 ? "" : "s"} differ`;
  }
  return "Same family as a Google Font";
}

export function DuplicateFinder() {
  const localFonts = useFontStore((s) => s.localFonts);
  const googleFonts = useFontStore((s) => s.googleFonts);
  const removeLocalFont = useFontStore((s) => s.removeLocalFont);
  const hydrated = useFontStore((s) => s.hydrated);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    setScanning(true);
    void findDuplicates(localFonts, googleFonts)
      .then((next) => {
        if (cancelled) return;
        setGroups(next);
        setScanning(false);
      })
      .catch(() => {
        if (cancelled) return;
        setGroups([]);
        setScanning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hydrated, localFonts, googleFonts]);

  if (!hydrated || scanning) {
    return <div className="p-8 text-sm text-muted-foreground">Comparing uploaded files…</div>;
  }

  if (localFonts.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
        <p className="font-heading text-3xl">No local files yet</p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Upload fonts to scan for identical files — even when the names differ.
        </p>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
        <p className="font-heading text-3xl">No duplicates</p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {localFonts.length} uploaded file{localFonts.length === 1 ? "" : "s"} look unique (and none match a Google family).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 overflow-y-auto p-4 md:p-6">
      <div>
        <h1 className="font-heading text-3xl">Duplicates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Different names and sizes are unique. Same size is byte-compared; a tiny patch still counts as a duplicate. An upload that matches a Google family is also listed.
        </p>
      </div>
      {groups.map((group) => (
        <section key={group.key} className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {reasonLabel(group)}
          </p>
          <ul className="mt-3 divide-y divide-border">
            {group.fonts.map((font) => (
              <li key={font.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{font.family}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {font.fileName} · {font.fileSize ? formatBytes(font.fileSize) : ""} · {font.weights[0]}
                    {font.italic ? " italic" : ""}
                  </p>
                </div>
                {font.source === "local" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void removeLocalFont(font.id)}
                >
                  <Trash2 />
                  Delete
                </Button>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">Fontsource</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
