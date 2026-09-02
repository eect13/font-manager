import { useEffect, useState, type ReactNode } from "react";
import { Power, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/lib/fonts/hash";
import { findDuplicates, hideIdsFromDuplicateGroups, useFontStore } from "@/lib/fonts/store";
import type { DuplicateGroup, FontRecord } from "@/lib/fonts/types";
import { cn } from "@/lib/utils";

function reasonLabel(group: DuplicateGroup) {
  if (group.reason === "checksum" || group.diffBytes === 0) return "Identical file";
  if (group.reason === "binary") {
    const n = group.diffBytes ?? 0;
    return `Same size — ${n.toLocaleString()} byte${n === 1 ? "" : "s"} differ`;
  }
  const cat = group.fonts.find((f) => f.source === "google");
  if (group.fonts.some((f) => f.source === "system")) return "Same family as a system font";
  if (cat?.catalog === "other") return "Same family as a Fontsource face";
  return "Same family as a Google Font";
}

function providerLabel(font: FontRecord) {
  if (font.source === "local") return "Local file";
  if (font.source === "system") return "System";
  return font.catalog === "other" ? "Fontsource" : "Google Fonts";
}

function DuplicateHeader({ extra }: { extra?: ReactNode }) {
  const autoHide = useFontStore((s) => s.autoHideDuplicates);
  const setAutoHide = useFontStore((s) => s.setAutoHideDuplicates);
  return (
    <div>
      <h1 className="font-heading text-3xl">Duplicates</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Fontsource and Google Fonts do not overlap — Inter is one Google Fonts record, not a second
        Fontsource copy. Activate remaining on Fontsource cannot turn Google Fonts on, and the other
        way around. This page lists an upload next to that catalog family, or two uploads of the same
        file. Same size is byte-compared; a tiny patch still counts. Keep order:
        system fonts, then Fontsource / Google Fonts (they do not overlap), then
        uploads. System fonts cannot be deleted or deactivated.
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <Switch checked={autoHide} onCheckedChange={setAutoHide} />
        Auto-hide duplicates in the library
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        Keeps the system font when present, else the catalog family (or the larger
        file), hides extra uploads, and deactivates them. Activate on a catalog face
        unloads a local of that name, and the other way around. Files stay on disk.
      </p>
      {extra}
    </div>
  );
}

function DuplicateRow({ font }: { font: FontRecord }) {
  const on = useFontStore((s) => s.activatedSet.has(font.id) || s.pendingSet.has(font.id));
  const pending = useFontStore((s) => s.pendingSet.has(font.id));
  const toggleActivated = useFontStore((s) => s.toggleActivated);
  const removeLocalFont = useFontStore((s) => s.removeLocalFont);
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{font.family}</p>
        <p className="truncate text-xs text-muted-foreground">
          {providerLabel(font)}
          {font.fileName ? ` · ${font.fileName}` : ""}
          {font.fileSize ? ` · ${formatBytes(font.fileSize)}` : ""}
          {` · ${font.weights[0] ?? 400}`}
          {font.italic ? " italic" : ""}
        </p>
      </div>
      <Button
        size="sm"
        variant={on ? "default" : "outline"}
        className={cn(pending && !on && "animate-pulse")}
        onClick={() => toggleActivated(font.id)}
        disabled={font.source === "system"}
        aria-pressed={on}
        title={
          font.source === "system"
            ? "System font — already installed. View only."
            : on
            ? "Deactivate — the other copy of this family can then be activated"
            : "Activate — unloads the other copy of this family name"
        }
      >
        <Power />
        {on ? (pending ? "Queued" : "On") : "Activate"}
      </Button>
      {font.source === "local" ? (
        <Button size="sm" variant="ghost" onClick={() => void removeLocalFont(font.id)}>
          <Trash2 />
          Delete
        </Button>
      ) : null}
    </li>
  );
}

export function DuplicateFinder() {
  const localFonts = useFontStore((s) => s.localFonts);
  const googleFonts = useFontStore((s) => s.googleFonts);
  const systemFonts = useFontStore((s) => s.systemFonts);
  const hydrated = useFontStore((s) => s.hydrated);
  const autoHide = useFontStore((s) => s.autoHideDuplicates);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    setScanning(true);
    void findDuplicates(localFonts, googleFonts, systemFonts)
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
  }, [hydrated, localFonts, googleFonts, systemFonts]);

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
        <p className="text-sm text-muted-foreground">Comparing names and files…</p>
      </div>
    );
  }

  if (localFonts.length === 0 && systemFonts.length === 0) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <DuplicateHeader
          extra={
            <p className="mt-6 max-w-sm text-sm text-muted-foreground">
              Upload fonts to scan for identical files — even when the names differ. System fonts
              that share a name with a catalog family also appear here. Fontsource vs Google Fonts
              will not appear as a pair.
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
            <p className="mt-6 max-w-sm text-muted-foreground text-sm">
              {localFonts.length
                ? `${localFonts.length.toLocaleString()} uploaded file${localFonts.length === 1 ? "" : "s"} look unique (no catalog or system name match).`
                : "No overlapping family names between system fonts and the catalog."}
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
              <DuplicateRow key={font.id} font={font} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
