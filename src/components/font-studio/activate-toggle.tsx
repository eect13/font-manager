import { Power, ScanSearch } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { pruneUnknownFolders, repairIncompleteFamilies, syncManagedDocumentsRoot } from "@/lib/fonts/os-activate";
import { requestPersistentStorage, storageEstimate } from "@/lib/fonts/idb";
import { inDesktopShell } from "@/lib/desktop/open-fonts";
import { isFontsourceOnly, isGoogleCatalog } from "@/lib/fonts/catalog";
import { useFontStore } from "@/lib/fonts/store";
import type { FontRecord } from "@/lib/fonts/types";
import { isKnownGdiSessionIncapable } from "@/lib/fonts/gdi-incapable";
import { visibleFamilySet } from "@/lib/fonts/visible-families";

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
  const state = useFontStore.getState();
  const local = state.localFonts;
  const google = state.googleFonts;
  const settled = state.settledFamilySet;
  const live = state.activatedSet;
  const pending = state.pendingSet;

  // 1.0.205 P0: skip Settled / known Add=0 — never burn Activate All queue on faces that will not Live.
  const usable: string[] = [];
  for (const id of ids) {
    if (live.has(id) || pending.has(id)) continue;
    const font = findFontRecord(id, local, google);
    if (!font || font.source === "system") continue;
    if (settled.has(font.family.trim().toLowerCase())) continue;
    // 1.0.206b: allowlist skip even if settledFamilySet not hydrated yet.
    if (isKnownGdiSessionIncapable(font.family)) continue;
    usable.push(id);
  }
  if (!usable.length) {
    toast.message(`Nothing to activate in ${label}`, {
      description: "Already Live, pending, or Settled (known Add=0).",
    });
    return false;
  }

  // Soft confirm when bulk N > ~50 — warn minutes / offer Activate visible.
  if (usable.length > 50) {
    const vis = visibleFamilySet();
    const visibleIds = usable.filter((id) => {
      const font = findFontRecord(id, local, google);
      return font ? vis.has(font.family.trim().toLowerCase()) : false;
    });
    const minutes = Math.max(1, Math.ceil(usable.length / 40));
    const ok = window.confirm(
      `Activate ${usable.length.toLocaleString()} families in ${label}?\n\n` +
        `This can take ~${minutes}+ minutes. Word/Adobe stay honest (Add>0 only).\n\n` +
        `OK = Activate all ${usable.length.toLocaleString()}\n` +
        `Cancel = abort` +
        (visibleIds.length
          ? `\n\nTip: ${visibleIds.length.toLocaleString()} are visible now — use “Activate visible” from the menu for a faster pass.`
          : ""),
    );
    if (!ok) return false;
  }

  // Visible + selected + recent first; remainder background (progressive Live early).
  const ordered = orderActivateIds(usable, state);
  void activateInWaves(ordered, label);
  return true;
}

function findFontRecord(
  id: string,
  local: FontRecord[],
  google: FontRecord[],
): FontRecord | undefined {
  return local.find((f) => f.id === id) ?? google.find((f) => f.id === id);
}

/** Prefer viewport + selected + recent24, then the long tail. */
function orderActivateIds(
  ids: string[],
  state: ReturnType<typeof useFontStore.getState>,
): string[] {
  const local = state.localFonts;
  const google = state.googleFonts;
  const byId = new Map<string, FontRecord>();
  for (const f of [...local, ...google]) byId.set(f.id, f);
  const prefer = new Set<string>();
  const vis = visibleFamilySet();
  for (const id of ids) {
    const font = byId.get(id);
    if (font && vis.has(font.family.trim().toLowerCase())) prefer.add(id);
  }
  if (state.selectedId && ids.includes(state.selectedId)) prefer.add(state.selectedId);
  for (const id of state.recentIds.slice(0, 24)) {
    if (ids.includes(id)) prefer.add(id);
  }
  const head: string[] = [];
  const tail: string[] = [];
  for (const id of ids) {
    (prefer.has(id) ? head : tail).push(id);
  }
  return [...head, ...tail];
}

const ACTIVATE_WAVE = 40;

async function activateInWaves(ids: string[], label: string) {
  if (!ids.length) return;
  const desktop = await inDesktopShell();
  // Queue pending in waves so the UI stays responsive; each wave uses setActivatedMany.
  for (let i = 0; i < ids.length; i += ACTIVATE_WAVE) {
    const wave = ids.slice(i, i + ACTIVATE_WAVE);
    useFontStore.getState().setActivatedMany(wave, true);
    // Yield to paint progressive Live / progress owners between waves.
    await new Promise<void>((r) => window.setTimeout(r, 0));
  }
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
          : "Persistent storage on. Visible/recent first; Settled skipped. Files stay in Documents."
        : "Visible/recent first; Settled skipped. Files go to Documents.",
    },
  );
}


export function deactivateSet(ids: string[], label: string) {
  if (!ids.length) return;
  const { activatedSet, pendingSet, pendingDeactivateSet } = useFontStore.getState();
  const any = ids.some(
    (id) => activatedSet.has(id) || pendingSet.has(id) || pendingDeactivateSet.has(id),
  );
  if (!any) {
    toast.message(`Nothing on in ${label}`);
    return;
  }
  useFontStore.getState().setActivatedMany(ids, false);
  void inDesktopShell().then((desktop) => {
    if (!desktop) {
      toast.success(`${label} off — preview only`);
    }
  });
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


export function ActivateVisibleMenuItem({ ids, label }: { ids: string[]; label: string }) {
  const vis = visibleFamilySet();
  const visibleIds = useFontStore((s) => {
    const out: string[] = [];
    for (const id of ids) {
      if (s.activatedSet.has(id) || s.pendingSet.has(id)) continue;
      const font =
        s.localFonts.find((f) => f.id === id) ?? s.googleFonts.find((f) => f.id === id);
      if (!font || font.source === "system") continue;
      if (s.settledFamilySet.has(font.family.trim().toLowerCase())) continue;
      if (isKnownGdiSessionIncapable(font.family)) continue;
      if (vis.has(font.family.trim().toLowerCase())) out.push(id);
    }
    return out;
  });
  return (
    <DropdownMenuItem
      disabled={!visibleIds.length}
      onSelect={() => activateSet(visibleIds, `${label} (visible)`)}
    >
      <Power className="size-3.5" />
      Activate visible ({visibleIds.length.toLocaleString()})
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
          // syncManagedDocumentsRoot → setDiskFamilies + applyDiskStatusHonesty
          const rows = await syncManagedDocumentsRoot();
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
          const incomplete = rows.filter((r) => r.incomplete && !r.settled).map((r) => r.name);
          const settled = rows.filter((r) => r.settled).map((r) => r.name);
          const gCount = googleFonts.filter(isGoogleCatalog).length;
          const fsCount = googleFonts.filter(isFontsourceOnly).length;
          const live = useFontStore.getState().activated.length;
          const diskN = useFontStore.getState().diskFamilies.length;
          const baseBits = [
            `Live ${live.toLocaleString()} · Settled ${settled.length.toLocaleString()} · Google ${gCount.toLocaleString()} · Fontsource ${fsCount.toLocaleString()} · On disk ${diskN.toLocaleString()}`,
            `${files.toLocaleString()} intact TTF/OTF (${(bytes / (1024 * 1024)).toFixed(1)} MB)`,
            corrupt
              ? `${corrupt.toLocaleString()} corrupt (not TTF; WOFF is preview-only)`
              : "no corrupt files",
            settled.length
              ? `${settled.length.toLocaleString()} Settled (on disk · Windows won’t load — not Incomplete)`
              : null,
            "Explorer also counts .session-active.json — not a family",
          ].filter(Boolean) as string[];
          // One primary action only — Repair OR Remove extras, never both in one toast.
          if (incomplete.length) {
            toast.success(`Scan: ${rows.length.toLocaleString()} families on disk`, {
              description: [
                ...baseBits,
                `${incomplete.length.toLocaleString()} incomplete (face count short / no .complete / catalog VF missing / undersized vs Google — Repair)`,
                extras.length
                  ? `${extras.length.toLocaleString()} extras ignored until Repair finishes — Scan again to remove`
                  : "all catalog names match",
              ].join(" · "),
              duration: 14_000,
              action: {
                label: `Repair ${incomplete.length.toLocaleString()}`,
                onClick: () => void repairIncompleteFamilies(incomplete),
              },
            });
          } else if (extras.length) {
            toast.success(`Scan: ${rows.length.toLocaleString()} families on disk`, {
              description: [
                ...baseBits,
                settled.length ? `${settled.length.toLocaleString()} Settled · rest complete` : "all complete",
                `${extras.length.toLocaleString()} not in catalog (uploads or delisted)`,
              ].join(" · "),
              duration: 14_000,
              action: {
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
                        description:
                          "Folders still match the catalog, or the catalog is too small to prune against.",
                      });
                    }
                  })();
                },
              },
            });
          } else {
            toast.success(`Scan: ${rows.length.toLocaleString()} families on disk`, {
              description: [...baseBits, "matches catalog", "all complete"].join(" · "),
              duration: 6_000,
            });
          }
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
  pendingDeactivateSet: Set<string>,
  filter?: (font: FontRecord) => boolean,
) {
  let count = 0;
  let remaining = 0;
  let anyOn = false;
  for (const font of fonts) {
    if (filter && !filter(font)) continue;
    count += 1;
    if (
      activatedSet.has(font.id) ||
      pendingSet.has(font.id) ||
      pendingDeactivateSet.has(font.id)
    )
      anyOn = true;
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
    useShallow((s) =>
      catalogMenuStats(s.googleFonts, s.activatedSet, s.pendingSet, s.pendingDeactivateSet, filter),
    ),
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
      <ActivateVisibleMenuItem ids={ids()} label={label} />
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
      <ActivateVisibleMenuItem
        ids={[
          ...useFontStore.getState().googleFonts.map((f) => f.id),
          ...useFontStore.getState().localFonts.map((f) => f.id),
        ]}
        label="Library"
      />
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
