import { Power, ScanSearch } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { pruneUnknownFolders, scanDiskFamilies } from "@/lib/fonts/os-activate";
import { requestPersistentStorage, storageEstimate } from "@/lib/fonts/idb";
import { inDesktopShell } from "@/lib/desktop/open-fonts";
import { isFontsourceOnly, isGoogleCatalog } from "@/lib/fonts/catalog";
import { useFontStore } from "@/lib/fonts/store";
import type { FontRecord } from "@/lib/fonts/types";

function webPreviewNote(label: string) {
  if (label === "Fontsource") {
    return "This website previews Fontsource via CSS (jsDelivr). Use the desktop app to download files into Documents.";
  }
  if (label === "Google Fonts") {
    return "This website previews Google Fonts via CSS. Use the desktop app to download files into Documents.";
  }
  return "This website previews in the browser. Use the desktop app to download files into Documents.";
}

export function activateSet(ids: string[], label: string) {
  if (!ids.length) return false;
  useFontStore.getState().setActivatedMany(ids, true);
  void (async () => {
    const desktop = await inDesktopShell();
    const live = useFontStore.getState().activated.length;
    const pending = useFontStore.getState().pendingActivate.length;
    if (!desktop) {
      toast.success(`${label} on — ${live.toLocaleString()} live`, {
        description: webPreviewNote(label),
      });
      return;
    }
    const persisted = await requestPersistentStorage();
    const { quota, usage } = await storageEstimate();
    const room = quota ? quota - usage : Number.POSITIVE_INFINITY;
    toast.success(
      pending
        ? `Queuing ${pending.toLocaleString()} in ${label} — live ${live.toLocaleString()}`
        : `${live.toLocaleString()} in ${label} on`,
      {
        description: persisted
          ? room < 20 * 1024 * 1024
            ? "Persistent storage on, disk space is low — large families may fail."
            : "Persistent storage on. Files stay in Documents even if this origin is cleared."
          : "Files go to Documents. Browser cache is best-effort only.",
      },
    );
  })();
  return true;
}

export function deactivateSet(ids: string[], label: string) {
  if (!ids.length) return;
  const { activatedSet, pendingSet } = useFontStore.getState();
  const any = ids.some((id) => activatedSet.has(id) || pendingSet.has(id));
  if (!any) {
    toast.message(`Nothing on in ${label}`);
    return;
  }
  useFontStore.getState().setActivatedMany(ids, false);
  toast.success(`${label} off — unloaded from other apps, files kept`);
}

export function ActivateMenuItem({ ids, label }: { ids: string[]; label: string }) {
  const remaining = useFontStore((s) => {
    let n = 0;
    for (const id of ids) {
      if (!s.activatedSet.has(id) && !s.pendingSet.has(id)) n += 1;
    }
    return n;
  });
  const total = ids.length;
  return (
    <DropdownMenuItem disabled={!total} onSelect={() => activateSet(ids, label)}>
      <Power className="size-3.5" />
      {remaining && remaining < total
        ? `Activate remaining (${remaining.toLocaleString()})`
        : "Activate all"}
    </DropdownMenuItem>
  );
}

export function DeactivateMenuItem({ ids, label }: { ids: string[]; label: string }) {
  const anyOn = useFontStore((s) => ids.some((id) => s.activatedSet.has(id) || s.pendingSet.has(id)));
  return (
    <DropdownMenuItem disabled={!anyOn} onSelect={() => deactivateSet(ids, label)}>
      <Power className="size-3.5" />
      Deactivate all
    </DropdownMenuItem>
  );
}

export function ScanDiskMenuItem() {
  return (
    <DropdownMenuItem
      onSelect={() => {
        void (async () => {
          const rows = await scanDiskFamilies();
          if (!rows.length) {
            toast.message("No font files on disk yet", {
              description: "Documents → Font Manager is empty. Activate to download.",
            });
            return;
          }
          const { googleFonts, localFonts } = useFontStore.getState();
          const keepKeys = new Set<string>();
          const addKeep = (name: string) => {
            const t = name.trim();
            if (!t) return;
            keepKeys.add(t.toLowerCase());
            keepKeys.add(
              t
                .toLowerCase()
                .replace(/['’]/g, "")
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, ""),
            );
          };
          for (const font of googleFonts) addKeep(font.family);
          for (const font of localFonts) addKeep(font.family);
          const extras = rows.filter((row) => {
            const n = row.name.trim();
            const slug = n
              .toLowerCase()
              .replace(/['’]/g, "")
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "");
            return !keepKeys.has(n.toLowerCase()) && !keepKeys.has(slug);
          });
          const bytes = rows.reduce((n, r) => n + (r.bytes || 0), 0);
          const files = rows.reduce((n, r) => n + (r.files || 0), 0);
          const corrupt = rows.reduce((n, r) => n + (r.corrupt || 0), 0);
          const catalog = googleFonts.length;
          toast.success(`Scan: ${rows.length.toLocaleString()} families on disk`, {
            description: [
              `${files.toLocaleString()} intact TTF/OTF (${(bytes / (1024 * 1024)).toFixed(1)} MB)`,
              `catalog ${catalog.toLocaleString()}`,
              extras.length
                ? `${extras.length.toLocaleString()} not in catalog (uploads or delisted)`
                : "matches catalog",
              corrupt
                ? `${corrupt.toLocaleString()} corrupt (not TTF)`
                : "no corrupt files",
              "Explorer also counts .session-active.json — not a family",
            ].join(" · "),
            duration: extras.length ? 12_000 : 6_000,
            action: extras.length
              ? {
                  label: `Remove ${extras.length.toLocaleString()} extras`,
                  onClick: () => {
                    void (async () => {
                      const keep = [
                        ...googleFonts.map((f) => f.family),
                        ...localFonts.map((f) => f.family),
                      ];
                      const n = await pruneUnknownFolders(keep);
                      if (n) {
                        toast.success(`Removed ${n.toLocaleString()} folders not in catalog`);
                      } else {
                        toast.message("Nothing removed", {
                          description: "Folders still match the catalog, or the catalog is too small to prune against.",
                        });
                      }
                    })();
                  },
                }
              : undefined,
          });
        })();
      }}
    >
      <ScanSearch className="size-3.5" />
      Scan disk — verify files
    </DropdownMenuItem>
  );
}

export function GoogleActivateMenuItem() {
  return (
    <CatalogActivateMenuItem
      label="Fontsource"
      filter={isFontsourceOnly}
    />
  );
}

export function GfontsActivateMenuItem() {
  return (
    <CatalogActivateMenuItem
      label="Google Fonts"
      filter={isGoogleCatalog}
    />
  );
}

function catalogMenuStats(
  fonts: FontRecord[],
  activatedSet: Set<string>,
  pendingSet: Set<string>,
  filter?: (font: FontRecord) => boolean,
) {
  let count = 0;
  let remaining = 0;
  let anyOn = false;
  for (const font of fonts) {
    if (filter && !filter(font)) continue;
    count += 1;
    if (activatedSet.has(font.id) || pendingSet.has(font.id)) anyOn = true;
    else remaining += 1;
  }
  return { count, remaining, anyOn };
}

function CatalogActivateMenuItem({
  label,
  filter,
}: {
  label: string;
  filter?: (font: FontRecord) => boolean;
}) {
  const { count, remaining, anyOn } = useFontStore(
    useShallow((s) => catalogMenuStats(s.googleFonts, s.activatedSet, s.pendingSet, filter)),
  );
  function ids() {
    const list = useFontStore.getState().googleFonts;
    return filter ? list.filter(filter).map((font) => font.id) : list.map((font) => font.id);
  }
  return (
    <>
      <DropdownMenuItem disabled={!count} onSelect={() => activateSet(ids(), label)}>
        <Power className="size-3.5" />
        {remaining && remaining < count
          ? `Activate remaining (${remaining.toLocaleString()})`
          : "Activate all"}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!anyOn} onSelect={() => deactivateSet(ids(), label)}>
        <Power className="size-3.5" />
        Deactivate all
      </DropdownMenuItem>
      <ScanDiskMenuItem />
    </>
  );
}

export function LibraryActivateMenuItem() {
  const count = useFontStore((s) => s.googleFonts.length + s.localFonts.length);
  const remaining = useFontStore((s) => {
    const hide = s.autoHideDuplicates ? new Set(s.duplicateHideIds) : null;
    let n = 0;
    for (const font of s.googleFonts) {
      if (!s.activatedSet.has(font.id) && !s.pendingSet.has(font.id)) n += 1;
    }
    for (const font of s.localFonts) {
      if (hide?.has(font.id)) continue;
      if (!s.activatedSet.has(font.id) && !s.pendingSet.has(font.id)) n += 1;
    }
    return n;
  });
  const anyOn = useFontStore((s) => {
    for (const font of s.googleFonts) {
      if (s.activatedSet.has(font.id) || s.pendingSet.has(font.id)) return true;
    }
    for (const font of s.localFonts) {
      if (s.activatedSet.has(font.id) || s.pendingSet.has(font.id)) return true;
    }
    return false;
  });
  return (
    <>
      <DropdownMenuItem
        disabled={!count}
        onSelect={() => {
          const { googleFonts, localFonts } = useFontStore.getState();
          activateSet(
            [...googleFonts, ...localFonts].map((font) => font.id),
            "Library",
          );
        }}
      >
        <Power className="size-3.5" />
        {remaining && remaining < count
          ? `Activate remaining (${remaining.toLocaleString()})`
          : "Activate all"}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!anyOn}
        onSelect={() => {
          const { googleFonts, localFonts } = useFontStore.getState();
          deactivateSet(
            [...googleFonts, ...localFonts].map((font) => font.id),
            "Library",
          );
        }}
      >
        <Power className="size-3.5" />
        Deactivate all
      </DropdownMenuItem>
    </>
  );
}

export function ActivatedDeactivateMenuItem() {
  const count = useFontStore((s) => s.activated.length);
  return (
    <DropdownMenuItem
      disabled={!count}
      onSelect={() => {
        deactivateSet(useFontStore.getState().activated, "Activated");
      }}
    >
      <Power className="size-3.5" />
      Deactivate all
    </DropdownMenuItem>
  );
}
