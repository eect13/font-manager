import { useEffect, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/lib/fonts/hash";
import { findDuplicates, hideIdsFromDuplicateGroups, useFontStore } from "@/lib/fonts/store";
import type { DuplicateGroup, FontRecord } from "@/lib/fonts/types";

function reasonLabel(group: DuplicateGroup) {
  if (group.reason === "checksum" || group.diffBytes === 0) return "Identical file";
  if (group.reason === "binary") {
    const n = group.diffBytes ?? 0;
    return `Same size — ${n.toLocaleString()} byte${n === 1 ? "" : "s"} differ`;
  }
  return "Same family as a catalog font";
}

function providerLabel(font: FontRecord) {
  if (font.source !== "google") return null;
  return font.catalog === "other" ? "Fontsource" : "Google Fonts";
}

function DuplicateHeader({ extra }: { extra?: ReactNode }) {
  const autoHide = useFontStore((s) => s.autoHideDuplicates);
  const setAutoHide = useFontStore((s) => s.setAutoHideDuplicates);
  return (
    <div>
      <h1 className="font-heading text-3xl">Duplicates</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Different names and sizes are unique. Same size is byte-compared; a tiny patch still counts as a duplicate. An
        upload that matches a Fontsource or Google family is also listed.
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <Switch checked={autoHide} onCheckedChange={setAutoHide} />
        Auto-hide duplicates in the library
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        Keeps the Google Fonts / Fontsource family (or the larger file) and deactivates extra uploads. Files stay on disk.
      </p>
      {extra}
    </div>
  );
}

export function DuplicateFinder() {
  const localFonts = useFontStore((s) => s.localFonts);
  const googleFonts = useFontStore((s) => s.googleFonts);
  const removeLocalFont = useFontStore((s) => s.removeLocalFont);
  const hydrated = useFontStore((s) => s.hydrated);
  const autoHide = useFontStore((s) => s.autoHideDuplicates);
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

  useEffect(() => {
    if (!autoHide || !groups.length) {
      if (!autoHide) useFontStore.setState({ duplicateHideIds: [] });
      return;
    }
    const hide = hideIdsFromDuplicateGroups(groups);
    useFontStore.setState({ duplicateHideIds: hide });
    if (hide.length) useFontStore.getState().setActivatedMany(hide, false);
  }, [autoHide, groups]);

  if (!hydrated || scanning) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <DuplicateHeader />
        <p className="text-sm text-muted-foreground">Comparing uploaded files…</p>
      </div>
    );
  }

  if (localFonts.length === 0) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <DuplicateHeader
          extra={
            <p className="mt-6 max-w-sm text-sm text-muted-foreground">
              Upload fonts to scan for identical files — even when the names differ.
            </p>
          }
        />
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <DuplicateHeader
          extra={
            <p className="mt-6 max-w-sm text-sm text-muted-foreground">
              {localFonts.length} uploaded file{localFonts.length === 1 ? "" : "s"} look unique (and none match a catalog
              family).
            </p>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 overflow-y-auto p-4 md:p-6">
      <DuplicateHeader />
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
                  <span className="shrink-0 text-xs text-muted-foreground">{providerLabel(font)}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
