import { toast } from "sonner";
import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import { FONT_BY_ID, GOOGLE_FONTS, isFontsourceOnly, isGoogleCatalog } from "./catalog";
import { notifyIfUnusual } from "./color-font";
import { isKnownGdiSessionIncapable, isSoftGdiTryAddFirst, KNOWN_GDI_SESSION_INCAPABLE } from "./gdi-incapable";
import { bytesNearlySame } from "./binary-diff";
import { idbDelete, idbGet, idbPutMany } from "./idb";
import { loadFont, unloadLocalFont } from "./loader";
import { inferLocalStyle } from "./style-tags";
import { bindAxesPersist, setLiveAxis } from "./live-axes";
import { clearSessionGdiRefused, removeUploadFromDisk, saveUploadToDisk, syncFontOnSystem, syncFontsOnSystem, uninstallFontOnSystem } from "./os-activate";
import { scheduleSaveLocalFontsMeta } from "./persist-local";
import type {
  Collection,
  DuplicateGroup,
  FontLicense,
  FontMetrics,
  FontRecord,
  LibraryFacet,
  LibraryScope,
  LibrarySort,
  PreviewSettings,
} from "./types";
import { DEFAULT_PREVIEW, isFacetScope } from "./types";
import { fontLicense, refineLicense, coerceLicense } from "./license";
import { fontMime } from "./fs-drop";
import { coerceDesktopPrefs, DEFAULT_DESKTOP_PREFS, type DesktopPrefs } from "@/lib/desktop/prefs";
import { fontMatchesSearch, mergeMetrics, parseSearchQuery } from "./metrics";
import { snapAxes } from "./axes";

const STORAGE_KEY = "font-manager:v1";
/** Persist version. v1 key kept so existing libraries don't vanish. v3 adds facet. */

function persistStorage(): StateStorage {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: { name: string; value: string } | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!last) return;
    localStorage.setItem(last.name, last.value);
    last = null;
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }
  return {
    getItem: (name) => {
      flush();
      return localStorage.getItem(name);
    },
    setItem: (name, value) => {
      last = { name, value };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 400);
    },
    removeItem: (name) => {
      last = null;
      if (timer) clearTimeout(timer);
      localStorage.removeItem(name);
    },
  };
}

interface PersistedSlice {
  favorites: string[];
  activated: string[];
  pendingActivate: string[];
  /** Deactivate queued — stay Live in chrome until unload confirms (symmetric with pendingActivate). */
  pendingDeactivate: string[];
  collections: Collection[];
  customTags: Record<string, string[]>;
  localFonts: FontRecord[];
  preview: PreviewSettings;
  scope: LibraryScope;
  facet: LibraryFacet;
  previewAxes: Record<string, Record<string, number>>;
  autoHideDuplicates: boolean;
  recentIds: string[];
  featurePrefs: Record<string, Record<string, boolean>>;
  desktopPrefs: DesktopPrefs;
}

interface FontState extends PersistedSlice {
  hydrated: boolean;
  googleFonts: FontRecord[];
  catalogLive: boolean;
  scope: LibraryScope;
  facet: LibraryFacet;
  query: string;
  selectedId: string | null;
  inspectorOpen: boolean;
  uploadBusy: boolean;
  diskFamilies: string[];
  diskFamilySet: Set<string>;
  /** Known GDI-incapable on disk (Add=0) — calm Settled, never Activated. */
  settledFamilies: string[];
  settledFamilySet: Set<string>;
  systemFonts: FontRecord[];
  systemBusy: boolean;
  activatedSet: Set<string>;
  pendingActivate: string[];
  pendingSet: Set<string>;
  pendingDeactivate: string[];
  pendingDeactivateSet: Set<string>;
  /** Pending-off exceeded N seconds (Word-locked) — Live stays; UI shows retry. */
  unloadStuckIds: string[];
  unloadStuckSet: Set<string>;
  setHydrated: (value: boolean) => void;
  setGoogleFonts: (fonts: FontRecord[]) => void;
  patchFontAxes: (id: string, axes: { tag: string; name: string; min: number; max: number; def: number }[]) => void;
  patchFontMetrics: (id: string, metrics: FontMetrics) => void;
  setCatalogLive: (value: boolean) => void;
  setScope: (scope: LibraryScope) => void;
  setFacet: (facet: LibraryFacet) => void;
  setQuery: (query: string) => void;
  setPreview: (patch: Partial<PreviewSettings>) => void;
  toggleFavorite: (id: string) => void;
  toggleActivated: (id: string) => void;
  setActivatedMany: (ids: string[], on: boolean) => void;
  toggleActivateSet: (ids: string[]) => boolean;
  markLiveActivated: (ids: string[]) => void;
  queuePendingActivate: (ids: string[]) => void;
  clearPendingActivate: (ids?: string[]) => void;
  queuePendingDeactivate: (ids: string[]) => void;
  clearPendingDeactivate: (ids?: string[]) => void;
  /** Unload confirmed — drop Live + pending-off for these ids. */
  confirmDeactivated: (ids: string[]) => void;
  pruneActivatedToFamilies: (families: string[]) => number;
  restoreActivation: (liveIds: string[], pendingIds: string[]) => void;
  selectFont: (id: string | null) => void;
  setInspectorOpen: (open: boolean) => void;
  setFeaturePref: (fontId: string, tag: string, on: boolean) => void;
  setDesktopPrefs: (patch: Partial<DesktopPrefs>) => void;
  setPreviewAxis: (id: string, tag: string, value: number) => void;
  setDiskFamilies: (names: string[]) => void;
  addDiskFamilies: (names: string[]) => void;
  /** P0: variable badge/facet = on-disk *-variable-* only; clear axes without VF. */
  applyDiskStatusHonesty: (rows: { name: string; has_variable?: boolean; hasVariable?: boolean; settled?: boolean; incomplete?: boolean }[]) => void;
  setSettledFamilies: (names: string[]) => void;
  addSettledFamilies: (names: string[]) => void;
  setSystemFonts: (fonts: FontRecord[]) => void;
  setSystemBusy: (value: boolean) => void;
  autoHideDuplicates: boolean;
  duplicateHideIds: string[];
  setAutoHideDuplicates: (on: boolean) => void;
  addCollection: (name: string, parentId?: string | null) => string;
  setCollectionWatch: (id: string, watchPath: string | undefined, autoActivate?: boolean) => void;
  setCollectionAutoActivate: (id: string, autoActivate: boolean) => void;
  renameCollection: (id: string, name: string) => void;
  deleteCollection: (
    id: string,
    opts?: { deleteFromDisk?: boolean },
  ) => { folders: number; fonts: number };
  moveCollection: (id: string, parentId: string | null) => void;
  toggleInCollection: (collectionId: string, fontId: string) => void;
  addToCollection: (collectionId: string, fontId: string) => void;
  setLicense: (id: string, license: FontLicense) => void;
  addTag: (fontId: string, tag: string) => void;
  removeTag: (fontId: string, tag: string) => void;
  importFiles: (
    files: File[],
    opts?: { collectionName?: string; collectionId?: string; originPaths?: string[] },
  ) => Promise<{ added: number; duplicates: number; failed: number; collectionId?: string }>;
  importOriginPaths: (
    paths: string[],
    opts?: { collectionName?: string; collectionId?: string },
  ) => Promise<{ added: number; duplicates: number; failed: number; collectionId?: string }>;
  removeLocalFont: (id: string) => Promise<void>;
  clearLocalFonts: () => Promise<number>;
  resetLibrary: () => Promise<number>;
}

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`;
}

function folderPathForOrigin(originPath: string, collectionName?: string): string[] {
  const parts = originPath.replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop();
  const name = collectionName?.trim();
  if (!name) return parts.slice(-2);
  const hit = parts.findIndex((p) => p.toLowerCase() === name.toLowerCase());
  if (hit >= 0) return parts.slice(hit);
  return [name];
}

function folderPathForFile(file: File, fallbackRoot?: string): string[] {
  const rel = (file.webkitRelativePath || "").replace(/\\/g, "/");
  const parts = rel.split("/").filter(Boolean);
  if (parts.length > 1) return parts.slice(0, -1);
  const root = fallbackRoot?.trim();
  return root ? [root] : [];
}

function ensureFolderPath(
  collections: Collection[],
  parentId: string | null,
  names: string[],
): { collections: Collection[]; leafId: string | null } {
  let pid: string | null = parentId;
  let leaf: string | null = parentId;
  let next = collections;
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const hit = next.find((c) => c.name === name && (c.parentId ?? null) === pid);
    if (hit) {
      leaf = hit.id;
      pid = hit.id;
      continue;
    }
    const id = uid("c");
    next = [
      ...next,
      { id, name, fontIds: [], createdAt: Date.now(), parentId: pid },
    ];
    leaf = id;
    pid = id;
  }
  return { collections: next, leafId: leaf };
}

const BUILTIN_FOLDER_IDS = new Set(["c-editorial", "c-geometric", "c-humanist", "c-code"]);

/** Drop catalog-seed folders (those sorts live under Tags). Keep user folders. */
function withoutBuiltinFolders(list: Collection[] | undefined): Collection[] {
  if (!list?.length) return [];
  return list
    .filter((c) => !BUILTIN_FOLDER_IDS.has(c.id))
    .map((c) => ({
      ...c,
      parentId: c.parentId && BUILTIN_FOLDER_IDS.has(c.parentId) ? null : (c.parentId ?? null),
    }));
}

const DEFAULT_ACTIVATED: string[] = [];

const LEGACY_SEED_ACTIVATED = new Set(["g:Inter", "g:Playfair Display", "g:JetBrains Mono"]);

function withActivated(activated: string[]) {
  return { activated, activatedSet: new Set(activated) };
}

function withPending(pendingActivate: string[]) {
  return { pendingActivate, pendingSet: new Set(pendingActivate) };
}

function withPendingDeactivate(pendingDeactivate: string[]) {
  return { pendingDeactivate, pendingDeactivateSet: new Set(pendingDeactivate) };
}

function withUnloadStuck(unloadStuckIds: string[]) {
  return { unloadStuckIds, unloadStuckSet: new Set(unloadStuckIds) };
}

/** Pending-off honesty timeout (Word may lock Remove). Keep Live; never fake Off. */
const PENDING_OFF_TIMEOUT_MS = 8_000;
const pendingOffTimers = new Map<string, number>();

function armPendingOffTimeout(ids: string[], get: () => any, set: (fn: any) => void) {
  for (const id of ids) {
    const prev = pendingOffTimers.get(id);
    if (prev) window.clearTimeout(prev);
    const handle = window.setTimeout(() => {
      pendingOffTimers.delete(id);
      const s = get();
      if (!s.pendingDeactivateSet.has(id)) return;
      // Still pending-off — surface stuck; keep Live honest.
      set((st: any) => ({
        ...withUnloadStuck(Array.from(new Set([...st.unloadStuckIds, id]))),
      }));
      toast.message("Still unloading", {
        id: `unload-stuck-${id}`,
        description:
          "Windows has not confirmed Remove yet (Word/Adobe may be locking the face). Live stays on — retry Deactivate when the app releases the font.",
        duration: 12_000,
      });
    }, PENDING_OFF_TIMEOUT_MS);
    pendingOffTimers.set(id, handle);
  }
}

function clearPendingOffTimeout(ids: string[]) {
  for (const id of ids) {
    const prev = pendingOffTimers.get(id);
    if (prev) window.clearTimeout(prev);
    pendingOffTimers.delete(id);
  }
}


function withDisk(names: string[]) {
  const diskFamilies: string[] = [];
  const diskFamilySet = new Set<string>();
  for (const raw of names) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (diskFamilySet.has(key)) continue;
    diskFamilySet.add(key);
    diskFamilies.push(t);
  }
  return { diskFamilies, diskFamilySet };
}

function withSettled(names: string[]) {
  const settledFamilies: string[] = [];
  const settledFamilySet = new Set<string>();
  for (const raw of names) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (settledFamilySet.has(key)) continue;
    settledFamilySet.add(key);
    settledFamilies.push(t);
  }
  return { settledFamilies, settledFamilySet };
}

function stripLegacySeedActivation(activated: string[] | undefined, localCount: number): string[] {
  const list = activated ?? [];
  if (localCount > 0) return list;
  if (!list.length) return list;
  if (list.every((id) => LEGACY_SEED_ACTIVATED.has(id))) return [];
  return list;
}


function familyKey(name: string) {
  return name.trim().toLowerCase();
}

function indexByFamily(fonts: FontRecord[]): Map<string, FontRecord[]> {
  const map = new Map<string, FontRecord[]>();
  for (const font of fonts) {
    const key = familyKey(font.family);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(font);
    else map.set(key, [font]);
  }
  return map;
}

function liveRivalFonts(
  font: FontRecord,
  localFonts: FontRecord[],
  googleFonts: FontRecord[],
  activated: Set<string>,
  pending: Set<string>,
): FontRecord[] {
  const key = familyKey(font.family);
  if (!key) return [];
  // Any other card id with the same family name (Google ↔ Fontsource ↔ local).
  // Never allow dual Live badges for one family name.
  const out: FontRecord[] = [];
  for (const other of [...localFonts, ...googleFonts]) {
    if (other.id === font.id) continue;
    if (familyKey(other.family) !== key) continue;
    if (activated.has(other.id) || pending.has(other.id)) out.push(other);
  }
  return out;
}

/** True when this family name is already Live or pending under any card id. */
function familyAlreadyLiveOrPending(
  font: FontRecord,
  localFonts: FontRecord[],
  googleFonts: FontRecord[],
  live: Set<string>,
  pending: Set<string>,
): boolean {
  if (live.has(font.id) || pending.has(font.id)) return true;
  return liveRivalFonts(font, localFonts, googleFonts, live, pending).length > 0;
}

/**
 * Catalog wins in a mixed batch (CSS / badge preference).
 * 1.0.204: never return GDI evict — exclusive Activate must not Remove→Add thrash.
 * If the family name is already Live/pending from any source, skip (Activate = no-op).
 */
function pickExclusiveActivate(
  incoming: FontRecord[],
  localFonts: FontRecord[],
  googleFonts: FontRecord[],
  live: Set<string>,
  pending: Set<string>,
): { chosen: FontRecord[]; evict: FontRecord[] } {
  const catalogIn: FontRecord[] = [];
  const catalogFam = new Set<string>();
  const localIn: FontRecord[] = [];
  for (const font of incoming) {
    // Already Live/pending under this id or a same-name rival → no-op (no Remove+Add).
    if (familyAlreadyLiveOrPending(font, localFonts, googleFonts, live, pending)) continue;
    if (font.source === "google") {
      catalogIn.push(font);
      catalogFam.add(familyKey(font.family));
    } else {
      localIn.push(font);
    }
  }
  const catalogIdx = indexByFamily(googleFonts);
  const chosenLocal: FontRecord[] = [];
  const seenLocal = new Set<string>();
  for (const font of localIn) {
    const key = familyKey(font.family);
    if (!key || catalogFam.has(key) || seenLocal.has(key)) continue;
    const catalogHit = catalogIdx.get(key);
    if (catalogHit?.some((f) => live.has(f.id) || pending.has(f.id))) continue;
    seenLocal.add(key);
    chosenLocal.push(font);
  }
  // Exclusive CSS/badge can stay catalog-preferred; GDI never Remove→Add for rivals.
  return { chosen: [...catalogIn, ...chosenLocal], evict: [] };
}

/** Soft Settled Power → Retry Add at most once per process (1.0.206e/f). */
const softSettledRetryTried = new Set<string>();

/** True after soft Settled Power Retry was used this process (tooltip honesty). */
export function softSettledRetryAlreadyTried(family: string): boolean {
  return softSettledRetryTried.has(family.trim().toLowerCase());
}

export const useFontStore = create<FontState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      googleFonts: GOOGLE_FONTS.slice(),
      catalogLive: false,
      favorites: [],
      ...withActivated(DEFAULT_ACTIVATED.slice()),
      ...withPending([]),
      ...withPendingDeactivate([]),
      ...withUnloadStuck([]),
      collections: [],
      customTags: {},
      localFonts: [],
      preview: DEFAULT_PREVIEW,
      scope: "all",
      facet: "",
      query: "",
      selectedId: null,
      inspectorOpen: false,
      uploadBusy: false,
      previewAxes: {},
      ...withDisk([]),
      ...withSettled([]),
      systemFonts: [],
      systemBusy: false,
      autoHideDuplicates: false,
      duplicateHideIds: [],
      recentIds: [],
      featurePrefs: {},
      desktopPrefs: { ...DEFAULT_DESKTOP_PREFS },
      setHydrated: (value) => set({ hydrated: value }),
      setGoogleFonts: (fonts) =>
        set((s) => {
          const prevById = new Map(s.googleFonts.map((f) => [f.id, f] as const));
          const googleFonts = fonts.map((font) => {
            const prev = prevById.get(font.id);
            if (!prev) return font;
            return {
              ...font,
              ...(prev.licenseUserSet
                ? { license: prev.license, licenseName: prev.licenseName, licenseUserSet: true as const }
                : {}),
              // Keep disk-VF honesty across catalog refresh even before axes are probed.
              ...(prev.variable
                ? {
                    variable: true as const,
                    ...(prev.axes?.length ? { axes: prev.axes } : {}),
                  }
                : {}),
            };
          });
          const ids = new Set(googleFonts.map((f) => f.id));
          for (const f of s.localFonts) ids.add(f.id);
          const activated = s.activated.filter((id) => ids.has(id) || id.startsWith("g:"));
          return { googleFonts, ...withActivated(activated) };
        }),
      patchFontAxes: (id, axes) =>
        set((s) => {
          // Real fvar from a loaded VF file → Variable. Empty axes must not keep a catalog lie.
          const patch = (font: FontRecord) =>
            font.id !== id
              ? font
              : {
                  ...font,
                  axes: axes.length ? snapAxes(axes) : undefined,
                  variable: axes.length > 0,
                };
          const gi = s.googleFonts.findIndex((f) => f.id === id);
          if (gi >= 0) {
            const googleFonts = s.googleFonts.slice();
            googleFonts[gi] = patch(googleFonts[gi]!);
            return { googleFonts };
          }
          const li = s.localFonts.findIndex((f) => f.id === id);
          if (li >= 0) {
            const localFonts = s.localFonts.slice();
            localFonts[li] = patch(localFonts[li]!);
            return { localFonts };
          }
          const si = s.systemFonts.findIndex((f) => f.id === id);
          if (si < 0) return s;
          const systemFonts = s.systemFonts.slice();
          systemFonts[si] = patch(systemFonts[si]!);
          return { systemFonts };
        }),
      patchFontMetrics: (id, metrics) =>
        set((s) => {
          const patch = (font: FontRecord) =>
            font.id !== id ? font : { ...font, metrics: mergeMetrics(font.metrics, metrics) };
          const gi = s.googleFonts.findIndex((f) => f.id === id);
          if (gi >= 0) {
            const googleFonts = s.googleFonts.slice();
            googleFonts[gi] = patch(googleFonts[gi]!);
            return { googleFonts };
          }
          const li = s.localFonts.findIndex((f) => f.id === id);
          if (li >= 0) {
            const localFonts = s.localFonts.slice();
            localFonts[li] = patch(localFonts[li]!);
            return { localFonts };
          }
          const si = s.systemFonts.findIndex((f) => f.id === id);
          if (si < 0) return s;
          const systemFonts = s.systemFonts.slice();
          systemFonts[si] = patch(systemFonts[si]!);
          return { systemFonts };
        }),
      setCatalogLive: (value) => set({ catalogLive: value }),
      setScope: (scope) => {
        if (isFacetScope(scope)) {
          set((s) => ({
            scope: isFacetScope(s.scope) ? "all" : s.scope,
            facet: s.facet === scope ? "" : scope,
          }));
          return;
        }
        set((s) => ({ scope, facet: s.scope === scope ? s.facet : "" }));
      },
      setFacet: (facet) =>
        set((s) => ({ facet: s.facet === facet ? "" : facet })),
      setQuery: (query) => set({ query }),
      setPreview: (patch) =>
        set((s) => ({ preview: { ...s.preview, ...patch } })),
      toggleFavorite: (id) =>
        set((s) => ({
          favorites: s.favorites.includes(id)
            ? s.favorites.filter((x) => x !== id)
            : [...s.favorites, id],
        })),
      toggleActivated: (id) => {
        const live = get().activatedSet.has(id);
        const pending = get().pendingSet.has(id);
        const pendingOff = get().pendingDeactivateSet.has(id);
        const font = findFont(id, get().localFonts, get().googleFonts);
        if (font?.source === "system") {
          return;
        }
        if (pending || pendingOff) {
          return;
        }
        // Settled Power: hard Gidugu = no-op; soft emoji = explicit Retry Add (one try/process).
        if (font && !live) {
          const famKey = font.family.trim().toLowerCase();
          if (get().settledFamilySet.has(famKey)) {
            if (isKnownGdiSessionIncapable(font.family)) {
              return; // hard Settled → no-op
            }
            if (isSoftGdiTryAddFirst(font.family)) {
              if (softSettledRetryTried.has(famKey)) {
                return; // one Retry Add per process
              }
              softSettledRetryTried.add(famKey);
              // 1.0.206g: set pending + drop Settled *synchronously* so a double-click
              // hits the pending gate and cannot bypass the soft one-try Retry path
              // while await clearSessionGdiRefused races (Skye P2).
              set((s) => ({
                ...withPending([...s.pendingActivate, id]),
                ...withSettled(s.settledFamilies.filter((n) => n.trim().toLowerCase() !== famKey)),
              }));
              // 1.0.206f: clear Rust session_gdi_refused BEFORE Activate so soft
              // early-skip does not return AddReturnedZero without Add (Skye P1 HOLD).
              void (async () => {
                await clearSessionGdiRefused(font.family);
                const st = get();
                // Abort if user toggled off / became Live / pending cleared while waiting.
                if (st.activatedSet.has(id) || st.pendingDeactivateSet.has(id) || !st.pendingSet.has(id)) {
                  return;
                }
                notifyIfUnusual(font, "activate");
                void syncFontOnSystem(font, true);
              })();
              return;
            } else {
              return;
            }
          }
        }
        if (live) {
          // Symmetric pending-off: keep Live until unload confirms.
          set((s) => ({
            ...withPendingDeactivate(Array.from(new Set([...s.pendingDeactivate, id]))),
            ...withPending(s.pendingActivate.filter((x) => x !== id)),
            ...withUnloadStuck(s.unloadStuckIds.filter((x) => x !== id)),
          }));
          armPendingOffTimeout([id], get, set);
          if (font) void syncFontOnSystem(font, false);
          return;
        }
        if (font) {
          // Family already Live from any source → Activate = no-op (no Remove→Add thrash).
          if (
            familyAlreadyLiveOrPending(
              font,
              get().localFonts,
              get().googleFonts,
              get().activatedSet,
              get().pendingSet,
            )
          ) {
            return;
          }
        }
        // Google and local both pending until register/download confirms (P0 honesty).
        set((s) => ({ ...withPending([...s.pendingActivate, id]) }));
        if (font) {
          notifyIfUnusual(font, "activate");
          void syncFontOnSystem(font, true);
        }
      },
      setActivatedMany: (ids, on) => {
        if (!ids.length) return;
        const local = get().localFonts;
        const google = get().googleFonts;
        if (!on) {
          const live = get().activatedSet;
          const pendingOff = get().pendingDeactivateSet;
          const pack: FontRecord[] = [];
          const offIds: string[] = [];
          for (const id of ids) {
            if (!live.has(id) && !get().pendingSet.has(id)) continue;
            if (pendingOff.has(id)) continue;
            const font = findFont(id, local, google);
            if (!font || font.source === "system") continue;
            pack.push(font);
            offIds.push(id);
          }
          if (!offIds.length) return;
          // Keep Live until unload confirms (pending-off honesty).
          set((s) => ({
            ...withPendingDeactivate(Array.from(new Set([...s.pendingDeactivate, ...offIds]))),
            ...withPending(s.pendingActivate.filter((id) => !new Set(offIds).has(id))),
            ...withUnloadStuck(s.unloadStuckIds.filter((id) => !new Set(offIds).has(id))),
          }));
          armPendingOffTimeout(offIds, get, set);
          if (pack.length) void syncFontsOnSystem(pack, false);
          return;
        }
        const live = get().activatedSet;
        const pending = get().pendingSet;
        const hide =
          get().autoHideDuplicates && get().duplicateHideIds.length
            ? new Set(get().duplicateHideIds)
            : null;
        const incoming: FontRecord[] = [];
        const settled = get().settledFamilySet;
        for (const id of ids) {
          if (live.has(id) || pending.has(id)) continue;
          if (hide?.has(id)) continue;
          const font = findFont(id, local, google);
          if (!font || font.source === "system") continue;
          // 1.0.205 P0: Activate All must not queue Settled / known Add=0.
          if (settled.has(font.family.trim().toLowerCase())) continue;
          // 1.0.206b: skip allowlist even when settled set not hydrated yet.
          if (isKnownGdiSessionIncapable(font.family)) continue;
          incoming.push(font);
        }
        // evict always [] in 1.0.204 — no chained Remove→Add.
        const { chosen } = pickExclusiveActivate(incoming, local, google, live, pending);
        const queuedIds: string[] = [];
        const pack: FontRecord[] = [];
        for (const font of chosen) {
          pack.push(font);
          queuedIds.push(font.id);
        }
        // Do not bump activated[] here — wait for markLiveActivated after GDI/register.
        if (queuedIds.length) {
          set((s) => withPending(Array.from(new Set([...s.pendingActivate, ...queuedIds]))));
        }
        if (pack.length) {
          const unusual = pack.find((f) => f.colorKind && f.colorKind !== "none");
          if (unusual) notifyIfUnusual(unusual, "activate");
          void syncFontsOnSystem(pack, true);
        }
      },
      toggleActivateSet: (ids) => {
        if (!ids.length) return false;
        const current = get().activatedSet;
        const allOn = ids.every((id) => current.has(id));
        get().setActivatedMany(ids, !allOn);
        return !allOn;
      },
      markLiveActivated: (ids) => {
        if (!ids.length) return;
        const pending = get().pendingSet;
        const live = get().activatedSet;
        const add = ids.filter((id) => pending.has(id) && !live.has(id));
        if (!add.length) {
          const leftover = get().pendingActivate.filter((id) => !ids.includes(id) || live.has(id));
          if (leftover.length !== get().pendingActivate.length) set(withPending(leftover));
          return;
        }
        set((s) => ({
          ...withActivated(Array.from(new Set([...s.activated, ...add]))),
          ...withPending(s.pendingActivate.filter((id) => !add.includes(id))),
          ...withPendingDeactivate(s.pendingDeactivate.filter((id) => !add.includes(id))),
        }));
        const locals = get().localFonts;
        const goog = get().googleFonts;
        const liveNow = get().activatedSet;
        const pendingNow = get().pendingSet;
        const evict: FontRecord[] = [];
        const drop = new Set<string>();
        for (const id of add) {
          const font = findFont(id, locals, goog);
          if (!font) continue;
          for (const rival of liveRivalFonts(font, locals, goog, liveNow, pendingNow)) {
            if (drop.has(rival.id)) continue;
            drop.add(rival.id);
            evict.push(rival);
          }
        }
        if (evict.length) {
          set((s) => ({
            ...withActivated(s.activated.filter((id) => !drop.has(id))),
            ...withPending(s.pendingActivate.filter((id) => !drop.has(id))),
          }));
        }
      },
      queuePendingActivate: (ids) => {
        if (!ids.length) return;
        set((s) => withPending(Array.from(new Set([...s.pendingActivate, ...ids]))));
      },
      clearPendingActivate: (ids) => {
        if (!ids) {
          set(withPending([]));
          return;
        }
        const drop = new Set(ids);
        set((s) => withPending(s.pendingActivate.filter((id) => !drop.has(id))));
      },
      queuePendingDeactivate: (ids) => {
        if (!ids.length) return;
        set((s) =>
          withPendingDeactivate(Array.from(new Set([...s.pendingDeactivate, ...ids]))),
        );
      },
      clearPendingDeactivate: (ids) => {
        if (!ids) {
          set(withPendingDeactivate([]));
          return;
        }
        const drop = new Set(ids);
        set((s) => withPendingDeactivate(s.pendingDeactivate.filter((id) => !drop.has(id))));
      },
      confirmDeactivated: (ids) => {
        if (!ids.length) return;
        const drop = new Set(ids);
        clearPendingOffTimeout(ids);
        set((s) => ({
          ...withActivated(s.activated.filter((id) => !drop.has(id))),
          ...withPending(s.pendingActivate.filter((id) => !drop.has(id))),
          ...withPendingDeactivate(s.pendingDeactivate.filter((id) => !drop.has(id))),
          ...withUnloadStuck(s.unloadStuckIds.filter((id) => !drop.has(id))),
        }));
      },
      pruneActivatedToFamilies: (families) => {
        const allow = new Set(families.map((n) => n.trim().toLowerCase()));
        const local = get().localFonts;
        const google = get().googleFonts;
        const next = get().activated.filter((id) => {
          const font = findFont(id, local, google);
          if (!font) return false;
          if (font.source === "local") return true;
          return allow.has(font.family.toLowerCase());
        });
        const removed = get().activated.length - next.length;
        if (removed > 0) set(withActivated(next));
        return removed;
      },
      restoreActivation: (liveIds, pendingIds) => {
        const live = Array.from(new Set(liveIds));
        const pending = Array.from(new Set(pendingIds.filter((id) => !live.includes(id))));
        // Fresh session restore — no stale pending-off from last Quit.
        set({ ...withActivated(live), ...withPending(pending), ...withPendingDeactivate([]) });
      },
      selectFont: (id) =>
        set((s) => ({
          selectedId: id,
          inspectorOpen: Boolean(id),
          recentIds: id ? [id, ...s.recentIds.filter((x) => x !== id)].slice(0, 40) : s.recentIds,
        })),
      setInspectorOpen: (open) =>
        set({ inspectorOpen: open, selectedId: open ? get().selectedId : null }),
      setFeaturePref: (fontId, tag, on) =>
        set((s) => ({
          featurePrefs: {
            ...s.featurePrefs,
            [fontId]: { ...(s.featurePrefs[fontId] ?? {}), [tag]: on },
          },
        })),
      setDesktopPrefs: (patch) =>
        set((s) => ({ desktopPrefs: { ...s.desktopPrefs, ...patch } })),
      setPreviewAxis: (id, tag, value) => {
        setLiveAxis(id, tag, value);
      },
      setDiskFamilies: (names) => set(withDisk(names)),
      setSettledFamilies: (names) => set(withSettled(names)),
      addSettledFamilies: (names) =>
        set((s) => {
          if (!names.length) return s;
          return withSettled([...s.settledFamilies, ...names]);
        }),
      applyDiskStatusHonesty: (rows) =>
        set((s) => {
          const vf = new Set<string>();
          const settledNames: string[] = [];
          for (const row of rows) {
            const n = row.name.trim();
            if (!n) continue;
            if (Boolean(row.has_variable ?? row.hasVariable)) {
              vf.add(n.toLowerCase());
            }
            if (row.settled) settledNames.push(n);
          }
          // Hard allowlist seed across disk honesty replace (Activate All skip).
          // Soft emoji Settled comes from Scan rows (`settled:true` only with `.settled-add-zero` provenance) —
          // never always-seed soft (would skip try-Add / cold-boot "Library complete" lie).
          for (const e of KNOWN_GDI_SESSION_INCAPABLE) settledNames.push(e.family);
          const googleFonts = s.googleFonts.map((font) => {
            const onDiskVf = vf.has(font.family.trim().toLowerCase());
            if (onDiskVf) {
              return { ...font, variable: true };
            }
            // Not on disk as VF — never catalog.variable / live API alone.
            if (!font.variable && !font.axes?.length) return font;
            return { ...font, variable: false, axes: undefined };
          });
          return { googleFonts, ...withSettled(settledNames) };
        }),
      addDiskFamilies: (names) =>
        set((s) => {
          if (!names.length) return s;
          return withDisk([...s.diskFamilies, ...names]);
        }),
      setSystemFonts: (fonts) => set({ systemFonts: fonts, systemBusy: false }),
      setSystemBusy: (value) => set({ systemBusy: value }),
      setAutoHideDuplicates: (on) => {
        if (!on) {
          set({ autoHideDuplicates: false, duplicateHideIds: [] });
          return;
        }
        const hide = familyDuplicateHideIds(get().localFonts, get().googleFonts, get().systemFonts);
        set({ autoHideDuplicates: true, duplicateHideIds: hide });
        if (hide.length) get().setActivatedMany(hide, false);
      },
      addCollection: (name, parentId = null) => {
        const id = uid("c");
        set((s) => ({
          collections: [
            ...s.collections,
            {
              id,
              name: name.trim() || "Untitled collection",
              fontIds: [],
              createdAt: Date.now(),
              parentId: parentId ?? null,
            },
          ],
        }));
        return id;
      },
      setCollectionWatch: (id, watchPath, autoActivate) => {
        set((s) => ({
          collections: s.collections.map((c) =>
            c.id === id
              ? {
                  ...c,
                  watchPath,
                  autoActivate: autoActivate ?? c.autoActivate,
                }
              : c,
          ),
        }));
        if (watchPath) void import("./watch-folder").then((m) => m.refreshWatchedFolders());
      },
      setCollectionAutoActivate: (id, autoActivate) =>
        set((s) => ({
          collections: s.collections.map((c) => (c.id === id ? { ...c, autoActivate } : c)),
        })),
      renameCollection: (id, name) =>
        set((s) => ({
          collections: s.collections.map((c) =>
            c.id === id ? { ...c, name: name.trim() || c.name } : c,
          ),
        })),
      deleteCollection: (id, opts) => {
        const s = get();
        const impact = folderDeleteImpact(s.collections, s.localFonts, id);
        if (!impact.folderIds.length) return { folders: 0, fonts: 0 };
        const folderIds = new Set(impact.folderIds);
        const removeLocal = new Set(impact.localFontIds);
        const parentId = s.collections.find((c) => c.id === id)?.parentId ?? null;
        const nextScope =
          typeof s.scope === "string" &&
          s.scope.startsWith("collection:") &&
          folderIds.has(s.scope.slice("collection:".length))
            ? parentId && !folderIds.has(parentId)
              ? (`collection:${parentId}` as const)
              : "all"
            : s.scope;
        const nextTags = { ...s.customTags };
        for (const fontId of impact.localFontIds) delete nextTags[fontId];
        const doomed = s.localFonts.filter((f) => removeLocal.has(f.id));
        set({
          collections: s.collections.filter((c) => !folderIds.has(c.id)),
          localFonts: s.localFonts.filter((f) => !removeLocal.has(f.id)),
          favorites: s.favorites.filter((x) => !removeLocal.has(x)),
          ...withActivated(s.activated.filter((x) => !removeLocal.has(x))),
          selectedId: s.selectedId && removeLocal.has(s.selectedId) ? null : s.selectedId,
          inspectorOpen: s.selectedId && removeLocal.has(s.selectedId) ? false : s.inspectorOpen,
          customTags: nextTags,
          scope: nextScope,
        });
        for (const font of doomed) {
          void unloadLocalFont(font.id);
          void idbDelete(font.id);
          if (opts?.deleteFromDisk) void removeUploadFromDisk(font);
          else void uninstallFontOnSystem(font);
        }
        return { folders: impact.folderIds.length, fonts: impact.localFontIds.length };
      },
      moveCollection: (id, parentId) =>
        set((s) => {
          if (id === parentId) return s;
          if (parentId && wouldCreateCycle(s.collections, id, parentId)) return s;
          return {
            collections: s.collections.map((c) =>
              c.id === id ? { ...c, parentId } : c,
            ),
          };
        }),
      toggleInCollection: (collectionId, fontId) =>
        set((s) => ({
          collections: s.collections.map((c) => {
            if (c.id !== collectionId) return c;
            const has = c.fontIds.includes(fontId);
            return {
              ...c,
              fontIds: has
                ? c.fontIds.filter((x) => x !== fontId)
                : [...c.fontIds, fontId],
            };
          }),
        })),
      addToCollection: (collectionId, fontId) =>
        set((s) => ({
          collections: s.collections.map((c) => {
            if (c.id !== collectionId || c.fontIds.includes(fontId)) return c;
            return { ...c, fontIds: [...c.fontIds, fontId] };
          }),
        })),
      setLicense: (id, license) =>
        set((s) => {
          const patch = (font: FontRecord) =>
            font.id === id ? { ...font, license, licenseUserSet: true } : font;
          const li = s.localFonts.findIndex((f) => f.id === id);
          if (li >= 0) {
            const localFonts = s.localFonts.slice();
            localFonts[li] = patch(localFonts[li]!);
            return { localFonts };
          }
          const gi = s.googleFonts.findIndex((f) => f.id === id);
          if (gi < 0) return s;
          const googleFonts = s.googleFonts.slice();
          googleFonts[gi] = patch(googleFonts[gi]!);
          return { googleFonts };
        }),
      addTag: (fontId, tag) => {
        const cleaned = tag.trim().toLowerCase();
        if (!cleaned) return;
        set((s) => {
          const current = s.customTags[fontId] ?? [];
          if (current.includes(cleaned)) return s;
          return {
            customTags: { ...s.customTags, [fontId]: [...current, cleaned] },
          };
        });
      },
      removeTag: (fontId, tag) =>
        set((s) => ({
          customTags: {
            ...s.customTags,
            [fontId]: (s.customTags[fontId] ?? []).filter((t) => t !== tag),
          },
        })),
      importFiles: async (files, opts) => {
        set({ uploadBusy: true });
        let added = 0;
        let duplicates = 0;
        let failed = 0;
        const existingHashes = new Set(
          get().localFonts.map((f) => f.checksum).filter(Boolean) as string[],
        );
        const newIds: string[] = [];
        const folderOf = new Map<string, string[]>();

        try {
          const { parseFilesPool, PARSE_WAVE } = await import("./parse-pool");
          const fileArr = Array.from(files);
          let collectionId = opts?.collectionId;
          let primed = false;
          for (let waveStart = 0; waveStart < fileArr.length; waveStart += PARSE_WAVE) {
            const wave = fileArr.slice(waveStart, waveStart + PARSE_WAVE);
            const originSlice = opts?.originPaths?.slice(waveStart, waveStart + PARSE_WAVE);
            const parsedList = await parseFilesPool(wave);
            for (const item of parsedList) {
              if (!item.ok) continue;
              item.faces = item.faces.map((parsed) => {
                const refined = refineLicense(parsed, {
                  fileName: item.file.name,
                  relativePath: item.file.webkitRelativePath,
                  collectionName: opts?.collectionName,
                });
                return { ...parsed, ...refined };
              });
            }

            const waveRecords: FontRecord[] = [];
            const waveBlobs: { id: string; blob: Blob }[] = [];
            const waveIds: string[] = [];
            const savedDisk = new Set<string>();
            for (let i = 0; i < parsedList.length; i += 1) {
              const item = parsedList[i]!;
              const file = wave[i];
              if (!item.ok) {
                failed += 1;
                continue;
              }
              for (const parsed of item.faces) {
                if (existingHashes.has(parsed.checksum)) {
                  duplicates += 1;
                  continue;
                }
                const id = uid("l");
                existingHashes.add(parsed.checksum);
                if (!originSlice?.[i]) {
                  waveBlobs.push({
                    id,
                    blob: new Blob([parsed.buffer], { type: fontMime(parsed.fileName) }),
                  });
                }
                const record: FontRecord = {
                  id,
                  family: parsed.family,
                  fullName: parsed.fullName && parsed.fullName !== parsed.family ? parsed.fullName : undefined,
                  source: "local",
                  category: parsed.category,
                  weights: [parsed.weight],
                  italic: parsed.italic,
                  variable: parsed.variable,
                  axes: parsed.axes.length ? snapAxes(parsed.axes) : undefined,
                  otFeatures: parsed.otFeatures.length ? parsed.otFeatures : undefined,
                  instances: parsed.instances.length ? parsed.instances : undefined,
                  varStorage: parsed.varStorage || undefined,
                  tags: parsed.tags.length ? parsed.tags : inferLocalStyle({ family: parsed.family, fileName: parsed.fileName }).tags,
                  popularity: 9999,
                  fileName: parsed.fileName,
                  fileSize: parsed.fileSize,
                  checksum: parsed.checksum,
                  version: parsed.version,
                  glyphCount: parsed.glyphCount,
                  cssFamily: parsed.family,
                  addedAt: file && file.lastModified > 0 ? file.lastModified : Date.now(),
                  license: parsed.license,
                  licenseName: parsed.licenseName || undefined,
                  kerningKey: parsed.kerningKey,
                  colorKind: parsed.colorKind,
                  originPath: originSlice?.[i],
                  metrics: parsed.metrics,
                };
                waveRecords.push(record);
                waveIds.push(id);
                newIds.push(id);
                added += 1;
                folderOf.set(
                  id,
                  folderPathForFile(file ?? ({ webkitRelativePath: "" } as File), opts?.collectionName),
                );
                if (!originSlice?.[i] && file && !savedDisk.has(file.name)) {
                  savedDisk.add(file.name);
                  void saveUploadToDisk({
                    family: parsed.family,
                    fileName: parsed.fileName || file.name,
                    buffer: parsed.buffer,
                  });
                }
              }
            }

            if (waveBlobs.length) {
              try {
                await idbPutMany(waveBlobs);
              } catch {
                const drop = new Set(waveBlobs.map((b) => b.id));
                failed += drop.size;
                added -= drop.size;
                for (let i = waveRecords.length - 1; i >= 0; i -= 1) {
                  if (drop.has(waveRecords[i]!.id)) waveRecords.splice(i, 1);
                }
              }
            }

            if (waveRecords.length) {
              const dropName = opts?.collectionName?.trim();
              if (collectionId) {
                const exists = get().collections.some((c) => c.id === collectionId);
                if (!exists) collectionId = undefined;
              }
              set((s) => {
                let collections = s.collections.slice();
                const parentName = collectionId
                  ? collections.find((c) => c.id === collectionId)?.name
                  : undefined;
                let rootId = collectionId ?? null;
                for (const record of waveRecords) {
                  let names = folderOf.get(record.id) ?? [];
                  if (collectionId && parentName && names[0] === parentName) {
                    names = names.slice(1);
                  }
                  if (!names.length && dropName && !collectionId) names = [dropName];
                  if (!names.length && !collectionId) continue;
                  const nested = ensureFolderPath(collections, collectionId ?? null, names);
                  collections = nested.collections;
                  const leaf = nested.leafId;
                  if (!rootId && names.length) {
                    const top = collections.find(
                      (c) => c.name === names[0] && (c.parentId ?? null) === null,
                    );
                    rootId = top?.id ?? leaf;
                  }
                  if (leaf) {
                    collections = collections.map((c) =>
                      c.id === leaf
                        ? { ...c, fontIds: Array.from(new Set([...c.fontIds, record.id])) }
                        : c,
                    );
                  }
                }
                collectionId = rootId ?? collectionId;
                return {
                  localFonts: [...waveRecords, ...s.localFonts],
                  ...(!opts?.originPaths?.length
                    ? withActivated(Array.from(new Set([...s.activated, ...waveIds])))
                    : {}),
                  collections,
                  scope: collectionId ? (`collection:${collectionId}` as const) : s.scope,
                };
              });
              if (!primed) {
                primed = true;
                const local = get().localFonts;
                const google = get().googleFonts;
                waveIds.slice(0, 2).forEach((id) => {
                  const font = findFont(id, local, google);
                  if (font) void loadFont(font);
                });
              }
            }
            await new Promise((r) => setTimeout(r, 0));
          }

          if (
            opts?.originPaths?.length &&
            newIds.length &&
            get().collections.find((c) => c.id === collectionId)?.autoActivate
          ) {
            get().setActivatedMany(newIds, true);
          }

          return { added, duplicates, failed, collectionId };
        } finally {
          set({ uploadBusy: false });
        }
      },
      importOriginPaths: async (paths, opts) => {
        set({ uploadBusy: true });
        let added = 0;
        let duplicates = 0;
        let failed = 0;
        const existingHashes = new Set(
          get().localFonts.map((f) => f.checksum).filter(Boolean) as string[],
        );
        const newIds: string[] = [];
        try {
          const { indexFontPaths, fontMetricsFromLayout } = await import("./native-parse");
          const { PARSE_WAVE } = await import("./parse-pool");
          let collectionId = opts?.collectionId;
          const fileArr = paths.filter(Boolean);
          for (let waveStart = 0; waveStart < fileArr.length; waveStart += PARSE_WAVE) {
            const wave = fileArr.slice(waveStart, waveStart + PARSE_WAVE);
            const indexed = await indexFontPaths(wave);
            const seenPath = new Set(indexed.map((row) => row.path));
            for (const p of wave) {
              if (!seenPath.has(p)) failed += 1;
            }
            const waveRecords: FontRecord[] = [];
            const waveIds: string[] = [];
            for (const row of indexed) {
              if (existingHashes.has(row.checksum)) {
                duplicates += 1;
                continue;
              }
              existingHashes.add(row.checksum);
              const id = uid("l");
              const style = inferLocalStyle({ family: row.family, fileName: row.fileName });
              const layoutMetrics = row.metrics
                ? fontMetricsFromLayout({
                    axes: row.axes,
                    otFeatures: row.otFeatures,
                    variable: row.variable,
                    glyphCount: row.glyphCount,
                    metrics: row.metrics,
                  })
                : undefined;
              waveRecords.push({
                id,
                family: row.family,
                fullName: row.fullName && row.fullName !== row.family ? row.fullName : undefined,
                source: "local",
                category: style.category,
                weights: [row.weight || 400],
                italic: row.italic,
                variable: row.variable,
                axes: row.axes.length ? row.axes : undefined,
                otFeatures: row.otFeatures.length ? row.otFeatures : undefined,
                tags: style.tags,
                popularity: 9999,
                fileName: row.fileName,
                fileSize: row.fileSize,
                checksum: row.checksum,
                glyphCount: row.glyphCount,
                cssFamily: row.family,
                addedAt: row.modifiedMs && row.modifiedMs > 0 ? row.modifiedMs : Date.now(),
                license: "unknown",
                originPath: row.path,
                metrics: layoutMetrics,
              });
              waveIds.push(id);
              newIds.push(id);
              added += 1;
            }
            if (waveRecords.length) {
              if (collectionId) {
                const exists = get().collections.some((c) => c.id === collectionId);
                if (!exists) collectionId = undefined;
              }
              set((s) => {
                let collections = s.collections.slice();
                const parentName = collectionId
                  ? collections.find((c) => c.id === collectionId)?.name
                  : undefined;
                let rootId = collectionId ?? null;
                for (const record of waveRecords) {
                  let names = folderPathForOrigin(record.originPath ?? "", opts?.collectionName);
                  if (collectionId && parentName && names[0] === parentName) names = names.slice(1);
                  if (!names.length && opts?.collectionName && !collectionId) names = [opts.collectionName];
                  if (!names.length && !collectionId) continue;
                  const nested = ensureFolderPath(collections, collectionId ?? null, names);
                  collections = nested.collections;
                  const leaf = nested.leafId;
                  if (!rootId && names.length) {
                    const top = collections.find(
                      (c) => c.name === names[0] && (c.parentId ?? null) === null,
                    );
                    rootId = top?.id ?? leaf;
                  }
                  if (leaf) {
                    collections = collections.map((c) =>
                      c.id === leaf
                        ? { ...c, fontIds: Array.from(new Set([...c.fontIds, record.id])) }
                        : c,
                    );
                  }
                }
                collectionId = rootId ?? collectionId;
                return {
                  localFonts: [...waveRecords, ...s.localFonts],
                  collections,
                  scope: collectionId ? (`collection:${collectionId}` as const) : s.scope,
                };
              });
            }
            await new Promise((r) => setTimeout(r, 0));
          }
          if (
            newIds.length &&
            get().collections.find((c) => c.id === collectionId)?.autoActivate
          ) {
            get().setActivatedMany(newIds, true);
          }
          return { added, duplicates, failed, collectionId };
        } finally {
          set({ uploadBusy: false });
        }
      },
      removeLocalFont: async (id) => {
        const font = get().localFonts.find((f) => f.id === id);
        await unloadLocalFont(id);
        await idbDelete(id);
        set((s) => ({
          localFonts: s.localFonts.filter((f) => f.id !== id),
          favorites: s.favorites.filter((x) => x !== id),
          ...withActivated(s.activated.filter((x) => x !== id)),
          selectedId: s.selectedId === id ? null : s.selectedId,
          collections: s.collections.map((c) => ({
            ...c,
            fontIds: c.fontIds.filter((fid) => fid !== id),
          })),
        }));
        if (font?.originPath) return;
        if (font) {
          const ok = await removeUploadFromDisk(font);
          if (!ok) {
            /* toast already shown; library row already removed — orphan risk noted */
          }
        }
      },
      clearLocalFonts: async () => {
        const fonts = get().localFonts.slice();
        const ids = fonts.map((f) => f.id);
        if (!ids.length) return 0;
        await Promise.all(
          ids.map(async (id) => {
            await unloadLocalFont(id);
            await idbDelete(id);
          }),
        );
        const remove = new Set(ids);
        set((s) => ({
          localFonts: [],
          favorites: s.favorites.filter((id) => !remove.has(id)),
          ...withActivated(s.activated.filter((id) => !remove.has(id))),
          selectedId: s.selectedId && remove.has(s.selectedId) ? null : s.selectedId,
          inspectorOpen: s.selectedId && remove.has(s.selectedId) ? false : s.inspectorOpen,
          collections: s.collections.map((c) => ({
            ...c,
            fontIds: c.fontIds.filter((id) => !remove.has(id)),
          })),
          customTags: Object.fromEntries(
            Object.entries(s.customTags).filter(([key]) => !remove.has(key)),
          ),
          scope: s.scope === "uploaded" ? "all" : s.scope,
        }));
        for (const font of fonts) void removeUploadFromDisk(font);
        return ids.length;
      },
      resetLibrary: async () => {
        const prev = get()
          .activated.map((id) => findFont(id, get().localFonts, get().googleFonts))
          .filter((f): f is FontRecord => Boolean(f));
        const n = await get().clearLocalFonts();
        set({
          collections: [],
          favorites: [],
          ...withActivated(DEFAULT_ACTIVATED.slice()),
          preview: DEFAULT_PREVIEW,
          scope: "all",
          facet: "",
          query: "",
          selectedId: null,
          inspectorOpen: false,
          customTags: {},
        });
        for (const font of prev) void uninstallFontOnSystem(font);
        return n;
      },
    }),
    {
      name: STORAGE_KEY,
      version: 6,
      storage: createJSONStorage(() => persistStorage()),
      skipHydration: true,
      migrate: (persisted, from) => {
        const p = (persisted ?? {}) as Partial<PersistedSlice> & Record<string, unknown>;
        const base: PersistedSlice = {
          favorites: Array.isArray(p.favorites) ? p.favorites : [],
          activated: Array.isArray(p.activated) ? p.activated : [],
          pendingActivate: Array.isArray(p.pendingActivate) ? p.pendingActivate : [],
          pendingDeactivate: [],
          collections: withoutBuiltinFolders(Array.isArray(p.collections) ? p.collections : []),
          customTags: p.customTags && typeof p.customTags === "object" ? p.customTags : {},
          localFonts: Array.isArray(p.localFonts) ? p.localFonts : [],
          preview: { ...DEFAULT_PREVIEW, ...(p.preview as PreviewSettings | undefined) },
          previewAxes: p.previewAxes && typeof p.previewAxes === "object" ? p.previewAxes : {},
          scope: (typeof p.scope === "string" ? p.scope : "all") as LibraryScope,
          facet: typeof p.facet === "string" ? (p.facet as LibraryFacet) : "",
          autoHideDuplicates: Boolean(p.autoHideDuplicates),
          recentIds: Array.isArray(p.recentIds) ? p.recentIds.filter((id) => typeof id === "string").slice(0, 40) : [],
          featurePrefs:
            p.featurePrefs && typeof p.featurePrefs === "object" ? p.featurePrefs : {},
          desktopPrefs: coerceDesktopPrefs(p.desktopPrefs),
        };
        if (from < 3 && isFacetScope(String(base.scope))) {
          base.facet = base.scope as LibraryFacet;
          base.scope = "all";
        }
        if (from < 4 && base.activated.length > 0 && (base.scope === "all" || !base.scope)) {
          base.scope = "activated";
        }
        return base;
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PersistedSlice>;
        const raw = stripLegacySeedActivation(p.activated ?? current.activated, (p.localFonts ?? current.localFonts).length);
        const known = new Set((p.localFonts ?? current.localFonts).map((f) => f.id));
        for (const f of current.googleFonts) known.add(f.id);
        const activated = raw.filter((id) => known.has(id) || id.startsWith("g:"));
        const pendingActivate = (p.pendingActivate ?? []).filter(
          (id) => (known.has(id) || id.startsWith("g:")) && !activated.includes(id),
        );
        return {
          ...current,
          ...p,
          ...withActivated(activated),
          ...withPending(pendingActivate),
          ...withPendingDeactivate([]),
          collections: withoutBuiltinFolders(p.collections ?? current.collections),
          localFonts: (p.localFonts ?? current.localFonts).map((f) => {
            if (f.licenseUserSet) {
              return { ...f, license: coerceLicense(f.license) };
            }
            const names = (p.collections ?? current.collections)
              .filter((c) => c.fontIds.includes(f.id))
              .map((c) => c.name);
            const refined = refineLicense(
              {
                license: f.license ?? "unknown",
                licenseName: f.licenseName,
                fileName: f.fileName,
              },
              { collectionNames: names, fileName: f.fileName },
            );
            return {
              ...f,
              license: refined.license,
              licenseName: refined.licenseName || f.licenseName,
            };
          }),
          preview: {
            ...DEFAULT_PREVIEW,
            ...p.preview,
            sort: p.preview?.sort ?? "name-asc",
            align: p.preview?.align ?? "left",
            italic: Boolean(p.preview?.italic),
          },
          previewAxes: p.previewAxes && typeof p.previewAxes === "object" ? p.previewAxes : {},
          scope: (() => {
            const next = isFacetScope(String(p.scope ?? "")) ? "all" : (p.scope ?? current.scope ?? "all");
            if (activated.length === 0 && next === "activated") return "all";
            return next;
          })(),
          facet:
            typeof p.facet === "string" && p.facet
              ? (p.facet as LibraryFacet)
              : isFacetScope(String(p.scope ?? ""))
                ? (p.scope as LibraryFacet)
                : "",
          autoHideDuplicates: Boolean(p.autoHideDuplicates),
          duplicateHideIds: Boolean(p.autoHideDuplicates)
            ? familyDuplicateHideIds(p.localFonts ?? current.localFonts, current.googleFonts, current.systemFonts)
            : [],
          recentIds: Array.isArray(p.recentIds) ? p.recentIds.filter((id) => typeof id === "string").slice(0, 40) : current.recentIds,
          featurePrefs: p.featurePrefs && typeof p.featurePrefs === "object" ? p.featurePrefs : current.featurePrefs,
          desktopPrefs: coerceDesktopPrefs(p.desktopPrefs ?? current.desktopPrefs),
        };
      },
      partialize: (s): PersistedSlice => ({
        favorites: s.favorites,
        activated: s.activated,
        pendingActivate: [],
        pendingDeactivate: [],
        collections: s.collections,
        customTags: s.customTags,
        // v5: upload catalog lives in IndexedDB (20k × JSON blows localStorage 5MB).
        localFonts: [],
        preview: s.preview,
        previewAxes: s.previewAxes,
        scope: s.scope,
        facet: s.facet,
        autoHideDuplicates: s.autoHideDuplicates,
        recentIds: s.recentIds,
        featurePrefs: s.featurePrefs,
        desktopPrefs: s.desktopPrefs,
      }),
    },
  ),
);

bindAxesPersist((axes) => {
  useFontStore.setState({ previewAxes: axes });
});

useFontStore.subscribe((s, prev) => {
  if (s.localFonts !== prev.localFonts) scheduleSaveLocalFontsMeta(s.localFonts);
});

export function allFonts(
  localFonts: FontRecord[],
  googleFonts: FontRecord[] = GOOGLE_FONTS,
): FontRecord[] {
  if (!localFonts.length) return googleFonts;
  if (!googleFonts.length) return localFonts;
  return [...localFonts, ...googleFonts];
}

/** Narrow the array *before* filter/sort so 20k locals are not copied when viewing Google Fonts / Activated. */
export function poolForScope(
  scope: LibraryScope,
  localFonts: FontRecord[],
  googleFonts: FontRecord[],
  systemFonts: FontRecord[] = [],
  liveIds: readonly string[] = [],
): FontRecord[] {
  if (scope === "system") return systemFonts;
  if (scope === "uploaded") return localFonts;
  if (scope === "gfonts" || scope === "google") return googleFonts;
  if (scope === "recent") return allFonts(localFonts, googleFonts).concat(systemFonts);
  // Activated drawer/facet: O(live), never allFonts(~22k) on every GDI tick.
  if (scope === "activated") {
    if (!liveIds.length) return [];
    const googleOnly = liveIds.every((id) => id.startsWith("g:"));
    const localById = googleOnly ? null : new Map(localFonts.map((f) => [f.id, f]));
    const googleById = new Map(googleFonts.map((f) => [f.id, f]));
    const systemById = systemFonts.length ? new Map(systemFonts.map((f) => [f.id, f])) : null;
    const out: FontRecord[] = [];
    const seen = new Set<string>();
    for (const id of liveIds) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // Prefer store googleFonts (disk VF honesty) over static FONT_BY_ID (variable:false).
      const font =
        localById?.get(id) ??
        googleById.get(id) ??
        systemById?.get(id) ??
        (id.startsWith("g:") ? FONT_BY_ID.get(id) : undefined) ??
        FONT_BY_ID.get(id);
      if (font) out.push(font);
    }
    return out;
  }
  return allFonts(localFonts, googleFonts);
}

export function findFont(
  id: string,
  localFonts: FontRecord[],
  googleFonts: FontRecord[] = GOOGLE_FONTS,
): FontRecord | undefined {
  if (id.startsWith("g:")) {
    return FONT_BY_ID.get(id) ?? googleFonts.find((f) => f.id === id);
  }
  if (id.startsWith("s:")) {
    return useFontStore.getState().systemFonts.find((f) => f.id === id);
  }
  return (
    localFonts.find((f) => f.id === id) ??
    googleFonts.find((f) => f.id === id) ??
    FONT_BY_ID.get(id)
  );
}

export function tagsFor(font: FontRecord, customTags: Record<string, string[]>): string[] {
  const extra = customTags[font.id] ?? [];
  return Array.from(new Set([...font.tags, ...extra]));
}

export function familyDuplicateHideIds(
  localFonts: FontRecord[],
  googleFonts: FontRecord[],
  systemFonts: FontRecord[] = [],
): string[] {
  const catalog = new Set(
    [...googleFonts, ...systemFonts].map((f) => f.family.toLowerCase()),
  );
  const seen = new Set<string>();
  const hide: string[] = [];
  for (const font of localFonts) {
    const key = font.family.toLowerCase();
    if (catalog.has(key) || seen.has(key)) hide.push(font.id);
    else seen.add(key);
  }
  return hide;
}

export function hideIdsFromDuplicateGroups(groups: DuplicateGroup[]): string[] {
  const hide: string[] = [];
  for (const group of groups) {
    const keep =
      group.fonts.find((f) => f.source === "system") ??
      group.fonts.find((f) => f.source === "google") ??
      [...group.fonts].sort((a, b) => (b.fileSize ?? 0) - (a.fileSize ?? 0))[0];
    if (!keep) continue;
    for (const font of group.fonts) {
      if (font.id !== keep.id && font.source === "local") hide.push(font.id);
    }
  }
  return hide;
}

function sourceRank(source: FontRecord["source"]) {
  if (source === "system") return 0;
  if (source === "google") return 1;
  return 2;
}

export async function findDuplicates(
  localFonts: FontRecord[],
  googleFonts: FontRecord[] = [],
  systemFonts: FontRecord[] = [],
): Promise<DuplicateGroup[]> {
  const groups: DuplicateGroup[] = [];
  const grouped = new Set<string>();

  const byHash = new Map<string, FontRecord[]>();
  for (const font of localFonts) {
    if (!font.checksum) continue;
    const list = byHash.get(font.checksum) ?? [];
    list.push(font);
    byHash.set(font.checksum, list);
  }
  for (const [hash, fonts] of byHash) {
    if (fonts.length < 2) continue;
    groups.push({ key: `hash:${hash}`, reason: "checksum", fonts, diffBytes: 0 });
    fonts.forEach((f) => grouped.add(f.id));
  }

  const rest = localFonts.filter((f) => !grouped.has(f.id));
  const bySize = new Map<number, FontRecord[]>();
  for (const font of rest) {
    const size = font.fileSize ?? 0;
    if (size <= 0) continue;
    const list = bySize.get(size) ?? [];
    list.push(font);
    bySize.set(size, list);
  }

  const toLoad = [...bySize.values()].filter((list) => list.length >= 2).flat();
  const buffers = new Map<string, Uint8Array>();
  await Promise.all(
    toLoad.map(async (font) => {
      const blob = await idbGet(font.id).catch(() => undefined);
      if (!blob) return;
      const buf = new Uint8Array(await blob.arrayBuffer());
      if (buf.byteLength) buffers.set(font.id, buf);
    }),
  );

  let cmp = 0;
  for (const [size, fonts] of bySize) {
    if (fonts.length < 2) continue;
    const parent = fonts.map((_, i) => i);
    const diffs = new Map<string, number>();
    const find = (i: number): number => {
      let p = i;
      while (parent[p] !== p) p = parent[p]!;
      let c = i;
      while (parent[c] !== p) {
        const n = parent[c]!;
        parent[c] = p;
        c = n;
      }
      return p;
    };
    const unite = (i: number, j: number) => {
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[a] = b;
    };

    for (let i = 0; i < fonts.length; i += 1) {
      const left = buffers.get(fonts[i]!.id);
      if (!left) continue;
      for (let j = i + 1; j < fonts.length; j += 1) {
        const right = buffers.get(fonts[j]!.id);
        if (!right) continue;
        cmp += 1;
        if (cmp % 8 === 0) await new Promise<void>((r) => setTimeout(r, 0));
        const { near, diffs: n } = bytesNearlySame(left, right);
        if (!near) continue;
        unite(i, j);
        const edge = `${Math.min(i, j)}:${Math.max(i, j)}`;
        diffs.set(edge, n);
      }
    }

    const clusters = new Map<number, FontRecord[]>();
    for (let i = 0; i < fonts.length; i += 1) {
      const root = find(i);
      const list = clusters.get(root) ?? [];
      list.push(fonts[i]!);
      clusters.set(root, list);
    }
    for (const [root, list] of clusters) {
      if (list.length < 2) continue;
      let worst = 0;
      for (let i = 0; i < fonts.length; i += 1) {
        if (find(i) !== root) continue;
        for (let j = i + 1; j < fonts.length; j += 1) {
          if (find(j) !== root) continue;
          worst = Math.max(worst, diffs.get(`${i}:${j}`) ?? 0);
        }
      }
      groups.push({
        key: `bin:${size}:${list.map((f) => f.id).join(",")}`,
        reason: worst === 0 ? "checksum" : "binary",
        fonts: list,
        diffBytes: worst,
      });
      list.forEach((f) => grouped.add(f.id));
    }
  }

  const googleByFamily = new Map(
    googleFonts.map((font) => [font.family.trim().toLowerCase(), font] as const),
  );
  const systemByFamily = new Map(
    systemFonts.map((font) => [font.family.trim().toLowerCase(), font] as const),
  );
  const seenFamily = new Set<string>();
  const names = new Set([
    ...googleByFamily.keys(),
    ...systemByFamily.keys(),
    ...localFonts.map((f) => f.family.trim().toLowerCase()),
  ]);
  for (const name of names) {
    if (!name || seenFamily.has(name)) continue;
    const sys = systemByFamily.get(name);
    const google = googleByFamily.get(name);
    const locals = localFonts.filter((f) => f.family.trim().toLowerCase() === name);
    const fonts = [sys, google, ...locals].filter((f): f is FontRecord => Boolean(f));
    const sources = new Set(fonts.map((f) => f.source));
    if (fonts.length < 2 || sources.size < 2) continue;
    seenFamily.add(name);
    fonts.sort((a, b) => sourceRank(a.source) - sourceRank(b.source) || a.id.localeCompare(b.id));
    groups.push({ key: `fam:${name}`, reason: "family-weight", fonts });
  }

  return groups;
}

export function matchesQuery(
  font: FontRecord,
  query: string,
  customTags: Record<string, string[]>,
): boolean {
  return fontMatchesSearch(font, parseSearchQuery(query), customTags);
}

export function filterLibrary(
  fonts: FontRecord[],
  scope: LibraryScope,
  query: string,
  favorites: string[],
  activated: string[],
  collections: Collection[],
  customTags: Record<string, string[]>,
  facet: LibraryFacet | string = "",
  recentIds: readonly string[] = [],
): FontRecord[] {
  let list = fonts;
  const where = isFacetScope(scope) ? "all" : scope;
  if (where === "activated") {
    const on = new Set(activated);
    list = list.filter((f) => on.has(f.id));
  } else if (where === "favorites") {
    const fav = new Set(favorites);
    list = list.filter((f) => fav.has(f.id));
  } else if (where === "uploaded") list = list.filter((f) => f.source === "local");
  else if (where === "recent") {
    const byId = new Map(list.map((f) => [f.id, f]));
    list = recentIds.map((id) => byId.get(id)).filter((f): f is FontRecord => Boolean(f));
  }
  else if (where === "google") list = list.filter(isFontsourceOnly);
  else if (where === "gfonts") list = list.filter(isGoogleCatalog);
  else if (where === "system") {
    list = list.filter((f) => f.source === "system");
  }
  else if (where.startsWith("collection:")) {
    const ids = collectFolderFontIds(collections, where.slice(11));
    list = list.filter((f) => ids.has(f.id));
  }
  const cut = facet || (isFacetScope(scope) ? scope : "");
  if (cut.startsWith("category:")) {
    const cat = cut.slice(9);
    list = list.filter((f) => f.category === cat);
  } else if (cut.startsWith("tag:")) {
    const tag = cut.slice(4);
    list = list.filter((f) => tagsFor(f, customTags).includes(tag));
  } else if (cut.startsWith("license:")) {
    const license = cut.slice(8) as FontLicense;
    list = list.filter((f) => fontLicense(f) === license);
  }
  if (query.trim()) list = list.filter((f) => matchesQuery(f, query, customTags));
  return list;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function sortLibrary(fonts: FontRecord[], sort: LibrarySort = "name-asc"): FontRecord[] {
  if (sort === "recent") {
    // Equal addedAt must stay in library order. A name tie-break made a whole
    // folder import look alphabetical (every file stamped in the same millisecond).
    return fonts
      .map((font, index) => ({ font, index, at: font.addedAt ?? 0 }))
      .sort((a, b) => b.at - a.at || a.index - b.index)
      .map((row) => row.font);
  }
  if (sort === "popular") {
    const keyed = fonts.map((font, index) => ({
      font,
      index,
      pop: font.popularity ?? 9999,
      name: font.family,
    }));
    keyed.sort((a, b) => a.pop - b.pop || collator.compare(a.name, b.name) || a.index - b.index);
    return keyed.map((row) => row.font);
  }
  const desc = sort === "name-desc";
  const keyed = fonts.map((font, index) => ({ font, index, name: font.family }));
  keyed.sort((a, b) => {
    const c = collator.compare(a.name, b.name);
    return (desc ? -c : c) || a.index - b.index;
  });
  return keyed.map((row) => row.font);
}

export function collectionIsWatched(collections: Collection[], id: string): boolean {
  const byId = new Map(collections.map((c) => [c.id, c]));
  let current: string | null = id;
  while (current) {
    const node = byId.get(current);
    if (!node) return false;
    if (node.watchPath) return true;
    current = node.parentId;
  }
  return false;
}

export function collectFolderTreeIds(collections: Collection[], id: string): string[] {
  const ids: string[] = [];
  const walk = (folderId: string) => {
    ids.push(folderId);
    for (const child of collections) {
      if (child.parentId === folderId) walk(child.id);
    }
  };
  walk(id);
  return ids;
}

export function folderDeleteImpact(
  collections: Collection[],
  localFonts: FontRecord[],
  id: string,
): { folderIds: string[]; localFontIds: string[]; folderName: string } {
  const folderIds = collections.some((c) => c.id === id) ? collectFolderTreeIds(collections, id) : [];
  const folderIdSet = new Set(folderIds);
  const remainingIds = new Set(
    collections.filter((c) => !folderIdSet.has(c.id)).flatMap((c) => c.fontIds),
  );
  const inDeleted = new Set<string>();
  for (const c of collections) {
    if (folderIdSet.has(c.id)) c.fontIds.forEach((fontId) => inDeleted.add(fontId));
  }
  const localSet = new Set(localFonts.map((f) => f.id));
  const localFontIds = [...inDeleted].filter((fontId) => localSet.has(fontId) && !remainingIds.has(fontId));
  return {
    folderIds,
    localFontIds,
    folderName: collections.find((c) => c.id === id)?.name ?? "Folder",
  };
}

export function collectFolderFontIds(collections: Collection[], id: string): Set<string> {
  return new Set(folderFontStats(collections).get(id)?.ids ?? []);
}

/** Apply auto-hide duplicate ids to folder/collection badge stats (shared). */
export function folderStatsWithAutoHide(
  collections: Collection[],
  hideDupIds: string[],
): Map<string, { count: number; ids: string[] }> {
  const raw = folderFontStats(collections);
  if (!hideDupIds.length) return raw;
  const hide = new Set(hideDupIds);
  const next = new Map<string, { count: number; ids: string[] }>();
  for (const [id, stat] of raw) {
    const ids = stat.ids.filter((fid) => !hide.has(fid));
    next.set(id, { count: ids.length, ids });
  }
  return next;
}

export function folderFontStats(
  collections: Collection[],
): Map<string, { count: number; ids: string[] }> {
  const byParent = new Map<string | null, Collection[]>();
  const byId = new Map<string, Collection>();
  for (const c of collections) {
    byId.set(c.id, c);
    const parent = c.parentId ?? null;
    const list = byParent.get(parent) ?? [];
    list.push(c);
    byParent.set(parent, list);
  }
  const map = new Map<string, { count: number; ids: string[] }>();
  const walk = (folderId: string): string[] => {
    const cached = map.get(folderId);
    if (cached) return cached.ids;
    const col = byId.get(folderId);
    if (!col) return [];
    const ids = new Set(col.fontIds);
    for (const child of byParent.get(folderId) ?? []) {
      for (const fontId of walk(child.id)) ids.add(fontId);
    }
    const list = [...ids];
    map.set(folderId, { count: list.length, ids: list });
    return list;
  };
  const known = new Set(collections.map((c) => c.id));
  for (const c of collections) {
    if (!c.parentId || !known.has(c.parentId)) walk(c.id);
  }
  return map;
}

export function folderTree(collections: Collection[]): { folder: Collection; depth: number }[] {
  const byParent = new Map<string | null, Collection[]>();
  for (const c of collections) {
    const parent = c.parentId ?? null;
    const list = byParent.get(parent) ?? [];
    list.push(c);
    byParent.set(parent, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  const ids = new Set(collections.map((c) => c.id));
  const rows: { folder: Collection; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of byParent.get(parentId) ?? []) {
      rows.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const c of collections) {
    if (c.parentId && !ids.has(c.parentId) && !rows.some((r) => r.folder.id === c.id)) {
      rows.push({ folder: { ...c, parentId: null }, depth: 0 });
    }
  }
  return rows;
}

function wouldCreateCycle(collections: Collection[], id: string, parentId: string): boolean {
  let current: string | null = parentId;
  const seen = new Set<string>();
  while (current) {
    if (current === id) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    current = collections.find((c) => c.id === current)?.parentId ?? null;
  }
  return false;
}
