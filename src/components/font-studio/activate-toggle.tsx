import { Power, RefreshCw, ScanSearch } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { armDocsVfSyncOwnership, cancelDownloadQueue, clearDocsVfSyncCancelPending, didDocsVfSyncCancelToast, pruneUnknownFolders, repairIncompleteFamilies, syncDocumentsVfPolicy, syncManagedDocumentsRoot } from "@/lib/fonts/os-activate";
import { docsCancelToastAction } from "@/lib/fonts/docs-cancel-toast-action";
import { requestPersistentStorage, storageEstimate } from "@/lib/fonts/idb";
import { inDesktopShell } from "@/lib/desktop/open-fonts";
import { isFontsourceOnly, isGoogleCatalog } from "@/lib/fonts/catalog";
import {
  filterLibrary,
  poolForScope,
  sortLibrary,
  useFontStore,
} from "@/lib/fonts/store";
import type { FontRecord } from "@/lib/fonts/types";
import { activateQueueIds, catalogMenuRemaining } from "@/lib/fonts/activate-queue.mjs";
import { requestActivateConfirm } from "@/lib/fonts/activate-confirm";
import { visibleFamilySet } from "@/lib/fonts/visible-families";
import {
  cancelLabelActivateIds,
  orderPreferKeys,
  PREFER_FIRST_PAGE,
  splitPreferRemainderIds,
} from "@/lib/fonts/prefer-order.mjs";

export { activateQueueIds, catalogMenuRemaining };

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

  // 1.0.205 P0 / 1.0.206i: skip Settled / hard Gidugu / pending-off — menu remaining uses same filter.
  const usable = activateQueueIds(ids, state);
  if (!usable.length) {
    toast.message(`Nothing to activate in ${label}`, {
      description: "Already Live, pending, or Settled (known Add=0).",
    });
    return false;
  }

  // 1.0.206m: one preferBuckets (visible + first-page) per Activate All.
  const buckets = preferBuckets(usable, state);
  const ordered = orderActivateIds(usable, state, buckets);
  const { prefer, remainder } = splitPreferRemainder(ordered, state, buckets);

  // Soft confirm when bulk N > ~50 — wave0 (prefer) immediately; remainder after in-app modal.
  if (usable.length > 50) {
    // 1.0.206n: reuse preferBuckets.visibleIds (no second visibleFamilySet pass).
    const visibleIds = buckets.visibleIds;
    // Cancel targets: visible, or first-page/selection/recent when visible=0 (P3).
    // 1.0.206o: buckets reused (no second preferBuckets). 1.0.206p: filter ordered /
    // reuse when all-visible — no second orderActivateIds prefer pass.
    const cancelIds = cancelLabelActivateIds(ordered, visibleIds, prefer);

    // Wave0: enqueue selected → favorites → viewport → first-page → recent immediately (1.0.206l).
    if (prefer.length) {
      void activateInWaves(prefer, `${label} (first)`);
    }

    void (async () => {
      const choice = await requestActivateConfirm({
        label,
        total: usable.length,
        preferCount: prefer.length,
        remainderCount: remainder.length,
        visibleCount: visibleIds.length,
        cancelCount: cancelIds.length,
        // Soften ETA — no hard minute promise.
        etaHint:
          "Large Activate All can take a while depending on downloads and Windows load.",
      });
      if (choice === "ok") {
        if (remainder.length) {
          void activateInWaves(remainder, label);
        } else if (!prefer.length) {
          void activateInWaves(ordered, label);
        }
        return;
      }
      if (choice === "cancel") {
        // Prefer already wave0 — Cancel keeps that queue (label: keep first / already queued).
        // If prefer empty, enqueue cancel fallback; label must match visible vs first-page.
        if (!prefer.length && cancelIds.length) {
          const cancelLabel =
            visibleIds.length > 0 ? `${label} (visible)` : `${label} (first page)`;
          void activateInWaves(cancelIds, cancelLabel);
        }
        return;
      }
      // Abort: leave wave0 if already queued; do not enqueue remainder.
    })();
    return true;
  }

  void activateInWaves(ordered, label);
  return true;
}


/** First-page ids of current library scope (intersected with candidates). */
function scopeFirstPageIds(
  ids: string[],
  state: ReturnType<typeof useFontStore.getState>,
): string[] {
  const idSet = new Set(ids);
  const liveIds = state.activated;
  const localPool =
    state.scope === "gfonts" || state.scope === "google" || state.scope === "system"
      ? []
      : state.localFonts;
  const pool = poolForScope(
    state.scope,
    localPool,
    state.googleFonts,
    state.systemFonts,
    liveIds,
  );
  const filtered = filterLibrary(
    pool,
    state.scope,
    state.query,
    state.favorites,
    liveIds,
    state.collections,
    state.customTags,
    state.facet,
    state.recentIds,
  );
  const sortMode =
    state.scope === "system" && (state.preview.sort ?? "name-asc") === "popular"
      ? "name-asc"
      : (state.preview.sort ?? "name-asc");
  const scoped = state.scope === "recent" ? filtered : sortLibrary(filtered, sortMode);
  const out: string[] = [];
  for (const font of scoped.slice(0, PREFER_FIRST_PAGE)) {
    if (idSet.has(font.id)) out.push(font.id);
  }
  return out;
}

/** Visible + first-page buckets for prefer waves (one call per Activate All). */
function preferBuckets(
  ids: string[],
  state: ReturnType<typeof useFontStore.getState>,
): { visibleIds: string[]; firstPageIds: string[] } {
  const local = state.localFonts;
  const google = state.googleFonts;
  const byId = new Map<string, FontRecord>();
  for (const f of [...local, ...google]) byId.set(f.id, f);
  const vis = visibleFamilySet();
  const visibleIds: string[] = [];
  for (const id of ids) {
    const font = byId.get(id);
    if (font && vis.has(font.family.trim().toLowerCase())) visibleIds.push(id);
  }
  return { visibleIds, firstPageIds: scopeFirstPageIds(ids, state) };
}

/** Prefer waves (1.0.206l): selected → favorites → viewport → first-page → recent → remainder. */
function orderActivateIds(
  ids: string[],
  state: ReturnType<typeof useFontStore.getState>,
  buckets?: { visibleIds: string[]; firstPageIds: string[] },
): string[] {
  const { visibleIds, firstPageIds } = buckets ?? preferBuckets(ids, state);
  return orderPreferKeys(ids, {
    selected: state.selectedId,
    favorites: state.favorites,
    visible: visibleIds,
    firstPage: firstPageIds,
    recent: state.recentIds,
  });
}

/** Wave0 prefer = selected + favorites + viewport + first-page + recent; remainder after confirm. */
function splitPreferRemainder(
  ids: string[],
  state: ReturnType<typeof useFontStore.getState>,
  buckets?: { visibleIds: string[]; firstPageIds: string[] },
): { prefer: string[]; remainder: string[] } {
  const { visibleIds, firstPageIds } = buckets ?? preferBuckets(ids, state);
  return splitPreferRemainderIds(ids, {
    selectedId: state.selectedId,
    favoriteIds: state.favorites,
    visibleIds,
    firstPageIds,
    recentIds: state.recentIds,
  });
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
          : "Persistent storage on. Selected/favorites/visible/first-page/recent first; Settled skipped. Files stay in Documents."
        : "Selected/favorites/visible/first-page/recent first; Settled skipped. Files go to Documents.",
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
      return;
    }
    // 1.0.206h: one calm queue toast (parity with Activate); remove bar still tracks unload.
    const pendingOff = useFontStore.getState().pendingDeactivate.length;
    toast.success(
      pendingOff
        ? `Queuing ${pendingOff.toLocaleString()} off in ${label}`
        : `${label} off`,
      { description: "Remove bar tracks unload. Files stay in Documents." },
    );
  });
}

export function ActivateMenuItem({ ids, label }: { ids: string[]; label: string }) {
  const remaining = useFontStore((s) => activateQueueIds(ids, s).length);
  const total = ids.length;
  const activateLabel =
    remaining && remaining < total
      ? `Activate remaining (${remaining.toLocaleString()})`
      : "Activate all";
  return (
    <DropdownMenuItem
      disabled={!total}
      aria-label={activateLabel === "Activate all" ? "Activate All" : activateLabel}
      data-testid="activate-all"
      onSelect={() => activateSet(ids, label)}
    >
      <Power className="size-3.5" />
      {activateLabel}
    </DropdownMenuItem>
  );
}


/** Visible ids for Activate visible — resolve at click, never as Zustand snapshot (1.0.206t #185). */
function resolveVisibleActivateIds(ids: string[]): string[] {
  const s = useFontStore.getState();
  const vis = visibleFamilySet();
  const out: string[] = [];
  // 1.0.206q: route Settled/hard skip through activateQueueIds (no dual filter);
  // then intersect viewport-visible families.
  for (const id of activateQueueIds(ids, s)) {
    const font =
      s.localFonts.find((f) => f.id === id) ?? s.googleFonts.find((f) => f.id === id);
    if (font && vis.has(font.family.trim().toLowerCase())) out.push(id);
  }
  return out;
}

export function ActivateVisibleMenuItem({ ids, label }: { ids: string[]; label: string }) {
  // 1.0.206t: subscribe to a primitive count only — returning a fresh string[] from
  // useFontStore (without useShallow) caused React 19 + Zustand 5 max update depth #185
  // when Library / catalog overflow menus mounted ActivateVisibleMenuItem.
  const visibleCount = useFontStore((s) => {
    const vis = visibleFamilySet();
    let n = 0;
    for (const id of activateQueueIds(ids, s)) {
      const font =
        s.localFonts.find((f) => f.id === id) ?? s.googleFonts.find((f) => f.id === id);
      if (font && vis.has(font.family.trim().toLowerCase())) n += 1;
    }
    return n;
  });
  return (
    <DropdownMenuItem
      disabled={!visibleCount}
      onSelect={() => activateSet(resolveVisibleActivateIds(ids), `${label} (visible)`)}
    >
      <Power className="size-3.5" />
      Activate visible ({visibleCount.toLocaleString()})
    </DropdownMenuItem>
  );
}

export function DeactivateMenuItem({ ids, label }: { ids: string[]; label: string }) {
  const anyOn = useFontStore((s) =>
    ids.some(
      (id) => s.activatedSet.has(id) || s.pendingSet.has(id) || s.pendingDeactivateSet.has(id),
    ),
  );
  return (
    <DropdownMenuItem
      disabled={!anyOn}
      aria-label="Deactivate All"
      data-testid="deactivate-all"
      onSelect={() => deactivateSet(ids, label)}
    >
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


export function RefreshDocumentsMenuItem() {
  return (
    <DropdownMenuItem
      aria-label="Refresh Documents folder"
      data-testid="refresh-documents"
      onSelect={() => {
        void (async () => {
          try {
            // Arm sticky before toast Cancel so mid-scan Cancel is docs-owned (not Download cancelled).
            armDocsVfSyncOwnership();
            toast.message("Refreshing Documents folder…", {
              id: "sync-docs-vf",
              description:
                "Removes redundant statics when a variable font is present. Keeps static-only families. Cancel from the progress bar.",
              duration: 8_000,
              action: docsCancelToastAction(),
            });
            const result = await syncDocumentsVfPolicy();
            if (!result) {
              toast.error("Could not refresh Documents", {
                id: "sync-docs-vf",
                description: "Activate/download may be running — Cancel or wait, then try again.",
              });
              return;
            }
            // 1.0.206ac: toast decision BEFORE rescan so cancelled/late always replaces
            // "Refreshing…" / "Cancelling…" even if syncManagedDocumentsRoot throws.
            if (result.cancelled) {
              if (!didDocsVfSyncCancelToast()) {
                toast.message("Documents refresh cancelled", {
                  id: "sync-docs-vf",
                  description: `Checked ${result.familiesSeen.toLocaleString()} folders · removed ${result.staticsDeleted.toLocaleString()} statics before cancel.`,
                });
              }
              try {
                await syncManagedDocumentsRoot();
              } catch {
                /* rescan best-effort after cancel */
              }
              return;
            }
            if (result.cancelArrivedLate) {
              didDocsVfSyncCancelToast();
              const n = result.staticsDeleted;
              toast.message(
                n === 0
                  ? "Cancel arrived after Documents refresh finished — no redundant statics removed"
                  : `Cancel arrived after Documents refresh finished — ${n.toLocaleString()} redundant statics removed`,
                {
                  id: "sync-docs-vf",
                  description: `${result.familiesSeen.toLocaleString()} folders checked before Cancel landed.`,
                },
              );
              try {
                await syncManagedDocumentsRoot();
              } catch {
                /* best-effort */
              }
              return;
            }
            try {
              await syncManagedDocumentsRoot();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err ?? "rescan failed");
              toast.error("Documents refreshed but library rescan failed", {
                id: "sync-docs-vf",
                description: msg,
              });
              return;
            }
            if (result.locked > 0) {
              toast.error(
                `${result.locked.toLocaleString()} face${result.locked === 1 ? "" : "s"} locked — deactivate fonts or quit Adobe/Word, then Repair`,
                {
                  id: "sync-docs-vf-locked",
                  description:
                    "Illustrator, fontdrvhost, or another app is holding static TTFs during Refresh. Quit those apps (or Deactivate), then Refresh or Repair again.",
                  duration: 24_000,
                },
              );
            }
            const lockBit = result.locked
              ? ` · ${result.locked.toLocaleString()} locked (Deactivate / quit Adobe, then Repair)`
              : "";
            toast.success(
              `Documents refreshed — ${result.staticsDeleted.toLocaleString()} redundant statics removed`,
              {
                id: "sync-docs-vf",
                description: `${result.familiesSeen.toLocaleString()} folders · ${result.familiesPurged.toLocaleString()} VF families updated${lockBit}. Static-only families kept.`,
                duration: 12_000,
              },
            );
          } finally {
            // Always drop sticky so a throw before toast cannot leave Cancel docs-owned forever.
            clearDocsVfSyncCancelPending();
          }
        })();
      }}
    >
      <RefreshCw className="size-3.5" />
      Refresh Documents — VF policy
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
  state: {
    activatedSet: Set<string>;
    pendingSet: Set<string>;
    pendingDeactivateSet: Set<string>;
    settledFamilySet: Set<string>;
    localFonts: FontRecord[];
    googleFonts: FontRecord[];
  },
  filter?: (font: FontRecord) => boolean,
) {
  let count = 0;
  let anyOn = false;
  for (const font of fonts) {
    if (filter && !filter(font)) continue;
    count += 1;
    if (
      state.activatedSet.has(font.id) ||
      state.pendingSet.has(font.id) ||
      state.pendingDeactivateSet.has(font.id)
    ) {
      anyOn = true;
    }
  }
  // 1.0.206i: remaining MUST call shared activateQueueIds (via catalogMenuRemaining).
  const remaining = catalogMenuRemaining(fonts, state, filter);
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
      catalogMenuStats(
        s.googleFonts,
        {
          activatedSet: s.activatedSet,
          pendingSet: s.pendingSet,
          pendingDeactivateSet: s.pendingDeactivateSet,
          settledFamilySet: s.settledFamilySet,
          localFonts: s.localFonts,
          googleFonts: s.googleFonts,
        },
        filter,
      ),
    ),
  );
  // 1.0.206t: stable catalog id list via useShallow — no fresh ids() each render.
  const catalogIds = useFontStore(
    useShallow((s) => {
      const list = s.googleFonts;
      return filter ? list.filter(filter).map((font) => font.id) : list.map((font) => font.id);
    }),
  );
  return (
    <>
      <DropdownMenuItem
        disabled={!count}
        aria-label={
          remaining && remaining < count
            ? `Activate remaining (${remaining.toLocaleString()})`
            : "Activate All"
        }
        data-testid="activate-all"
        onSelect={() => activateSet(catalogIds, label)}
      >
        <Power className="size-3.5" />
        {remaining && remaining < count
          ? `Activate remaining (${remaining.toLocaleString()})`
          : "Activate all"}
      </DropdownMenuItem>
      <ActivateVisibleMenuItem ids={catalogIds} label={label} />
      <DropdownMenuItem
        disabled={!anyOn}
        aria-label="Deactivate All"
        data-testid="deactivate-all"
        onSelect={() => deactivateSet(catalogIds, label)}
      >
        <Power className="size-3.5" />
        Deactivate all
      </DropdownMenuItem>
      <ScanDiskMenuItem />
      <RefreshDocumentsMenuItem />
    </>
  );
}

export function LibraryActivateMenuItem() {
  // 1.0.206t amend (Skye 7.2): Catalog-style array-root useShallow — do NOT nest a
  // fresh libraryIds[] inside a shallow object (nested Object.is always false → #185).
  const libraryIds = useFontStore(
    useShallow((s) => [
      ...s.googleFonts.map((f) => f.id),
      ...s.localFonts.map((f) => f.id),
    ]),
  );
  const count = useFontStore((s) => s.googleFonts.length + s.localFonts.length);
  const remaining = useFontStore((s) => {
    const hide = s.autoHideDuplicates ? new Set(s.duplicateHideIds) : null;
    const ids = [
      ...s.googleFonts.map((f) => f.id),
      ...s.localFonts.filter((f) => !hide?.has(f.id)).map((f) => f.id),
    ];
    return activateQueueIds(ids, s).length;
  });
  const anyOn = useFontStore((s) => {
    for (const font of s.googleFonts) {
      if (
        s.activatedSet.has(font.id) ||
        s.pendingSet.has(font.id) ||
        s.pendingDeactivateSet.has(font.id)
      )
        return true;
    }
    for (const font of s.localFonts) {
      if (
        s.activatedSet.has(font.id) ||
        s.pendingSet.has(font.id) ||
        s.pendingDeactivateSet.has(font.id)
      )
        return true;
    }
    return false;
  });
  return (
    <>
      <DropdownMenuItem
        disabled={!count}
        aria-label={
          remaining && remaining < count
            ? `Activate remaining (${remaining.toLocaleString()})`
            : "Activate All"
        }
        data-testid="activate-all"
        onSelect={() => activateSet(libraryIds, "Library")}
      >
        <Power className="size-3.5" />
        {remaining && remaining < count
          ? `Activate remaining (${remaining.toLocaleString()})`
          : "Activate all"}
      </DropdownMenuItem>
      <ActivateVisibleMenuItem ids={libraryIds} label="Library" />
      <DropdownMenuItem
        disabled={!anyOn}
        aria-label="Deactivate All"
        data-testid="deactivate-all"
        onSelect={() => deactivateSet(libraryIds, "Library")}
      >
        <Power className="size-3.5" />
        Deactivate all
      </DropdownMenuItem>
      <ScanDiskMenuItem />
      <RefreshDocumentsMenuItem />
    </>
  );
}

export function ActivatedDeactivateMenuItem() {
  const count = useFontStore((s) => s.activated.length);
  return (
    <DropdownMenuItem
      disabled={!count}
      aria-label="Deactivate All"
      data-testid="deactivate-all"
      onSelect={() => {
        deactivateSet(useFontStore.getState().activated, "Activated");
      }}
    >
      <Power className="size-3.5" />
      Deactivate all
    </DropdownMenuItem>
  );
}
