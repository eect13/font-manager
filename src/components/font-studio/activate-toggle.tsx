import { Power, ScanSearch } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { scanDiskFamilies } from "@/lib/fonts/os-activate";
import { requestPersistentStorage, storageEstimate } from "@/lib/fonts/idb";
import { useFontStore } from "@/lib/fonts/store";

export function activateSet(ids: string[], label: string) {
  if (!ids.length) return false;
  void (async () => {
    const persisted = await requestPersistentStorage();
    const { quota, usage } = await storageEstimate();
    const room = quota ? quota - usage : Number.POSITIVE_INFINITY;
    useFontStore.getState().setActivatedMany(ids, true);
    const live = useFontStore.getState().activated.length;
    const pending = useFontStore.getState().pendingActivate.length;
    toast.success(
      pending
        ? `Downloading ${pending.toLocaleString()} in ${label} — live ${live.toLocaleString()}`
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
          const bytes = rows.reduce((n, r) => n + (r.bytes || 0), 0);
          const files = rows.reduce((n, r) => n + (r.files || 0), 0);
          const corrupt = rows.reduce((n, r) => n + (r.corrupt || 0), 0);
          toast.success(`Scan: ${rows.length.toLocaleString()} families on disk`, {
            description: [
              `${files.toLocaleString()} intact TTF/OTF (${(bytes / (1024 * 1024)).toFixed(1)} MB)`,
              "header + table check — not a name count",
              corrupt ? `${corrupt.toLocaleString()} corrupt files removed` : "no corrupt files",
              "Activate skips intact files; Retry re-downloads missing ones",
            ].join(" · "),
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
  const count = useFontStore((s) => s.googleFonts.length);
  const remaining = useFontStore((s) => {
    let n = 0;
    for (const font of s.googleFonts) {
      if (!s.activatedSet.has(font.id) && !s.pendingSet.has(font.id)) n += 1;
    }
    return n;
  });
  const anyOn = useFontStore((s) => {
    for (const font of s.googleFonts) {
      if (s.activatedSet.has(font.id) || s.pendingSet.has(font.id)) return true;
    }
    return false;
  });
  return (
    <>
      <DropdownMenuItem
        disabled={!count}
        onSelect={() => {
          const ids = useFontStore.getState().googleFonts.map((font) => font.id);
          activateSet(ids, "Fontsource");
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
          const ids = useFontStore.getState().googleFonts.map((font) => font.id);
          deactivateSet(ids, "Fontsource");
        }}
      >
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
    let n = 0;
    for (const font of s.googleFonts) {
      if (!s.activatedSet.has(font.id) && !s.pendingSet.has(font.id)) n += 1;
    }
    for (const font of s.localFonts) {
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
