import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { FONT_BY_ID, GOOGLE_FONTS } from "./catalog";
import { notifyIfUnusual } from "./color-font";
import { bytesNearlySame } from "./binary-diff";
import { idbDelete, idbGet, idbPutMany } from "./idb";
import { loadFont, unloadLocalFont } from "./loader";
import { inferLocalStyle } from "./style-tags";
import { removeUploadFromDisk, saveUploadToDisk, syncFontOnSystem, syncFontsOnSystem, uninstallFontOnSystem } from "./os-activate";
import type {
  Collection,
  DuplicateGroup,
  FontLicense,
  FontRecord,
  LibraryScope,
  LibrarySort,
  PreviewSettings,
} from "./types";
import { DEFAULT_PREVIEW } from "./types";
import { fontLicense, licenseSearchHay, refineLicense, coerceLicense } from "./license";
import { fontMime } from "./fs-drop";


const STORAGE_KEY = "font-manager:v1";
/** Persist version. v1 key kept so existing libraries don't vanish. v2 adds scope + migrate. */

interface PersistedSlice {
  favorites: string[];
  activated: string[];
  pendingActivate: string[];
  collections: Collection[];
  customTags: Record<string, string[]>;
  localFonts: FontRecord[];
  preview: PreviewSettings;
  scope: LibraryScope;
}

interface FontState extends PersistedSlice {
  hydrated: boolean;
  googleFonts: FontRecord[];
  catalogLive: boolean;
  scope: LibraryScope;
  query: string;
  selectedId: string | null;
  inspectorOpen: boolean;
  uploadBusy: boolean;
  previewAxes: Record<string, Record<string, number>>;
  activatedSet: Set<string>;
  pendingActivate: string[];
  pendingSet: Set<string>;
  setHydrated: (value: boolean) => void;
  setGoogleFonts: (fonts: FontRecord[]) => void;
  patchFontAxes: (id: string, axes: { tag: string; name: string; min: number; max: number; def: number }[]) => void;
  setCatalogLive: (value: boolean) => void;
  setScope: (scope: LibraryScope) => void;
  setQuery: (query: string) => void;
  setPreview: (patch: Partial<PreviewSettings>) => void;
  toggleFavorite: (id: string) => void;
  toggleActivated: (id: string) => void;
  setActivatedMany: (ids: string[], on: boolean) => void;
  toggleActivateSet: (ids: string[]) => boolean;
  markLiveActivated: (ids: string[]) => void;
  queuePendingActivate: (ids: string[]) => void;
  clearPendingActivate: (ids?: string[]) => void;
  pruneActivatedToFamilies: (families: string[]) => number;
  restoreActivation: (liveIds: string[], pendingIds: string[]) => void;
  selectFont: (id: string | null) => void;
  setInspectorOpen: (open: boolean) => void;
  setPreviewAxis: (id: string, tag: string, value: number) => void;
  addCollection: (name: string, parentId?: string | null) => string;
  setCollectionWatch: (id: string, watchPath: string | undefined, autoActivate?: boolean) => void;
  setCollectionAutoActivate: (id: string, autoActivate: boolean) => void;
  renameCollection: (id: string, name: string) => void;
  deleteCollection: (id: string) => { folders: number; fonts: number };
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
  removeLocalFont: (id: string) => Promise<void>;
  clearLocalFonts: () => Promise<number>;
  resetLibrary: () => Promise<number>;
}

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`;
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

function stripLegacySeedActivation(activated: string[] | undefined, localCount: number): string[] {
  const list = activated ?? [];
  if (localCount > 0) return list;
  if (!list.length) return list;
  if (list.every((id) => LEGACY_SEED_ACTIVATED.has(id))) return [];
  return list;
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
      collections: [],
      customTags: {},
      localFonts: [],
      preview: DEFAULT_PREVIEW,
      scope: "all",
      query: "",
      selectedId: null,
      inspectorOpen: false,
      uploadBusy: false,
      previewAxes: {},
      setHydrated: (value) => set({ hydrated: value }),
      setGoogleFonts: (fonts) =>
        set((s) => {
          const ids = new Set(fonts.map((f) => f.id));
          for (const f of s.localFonts) ids.add(f.id);
          const activated = s.activated.filter((id) => ids.has(id));
          return { googleFonts: fonts, ...withActivated(activated) };
        }),
      patchFontAxes: (id, axes) =>
        set((s) => {
          const patch = (font: FontRecord) =>
            font.id !== id ? font : { ...font, axes, variable: axes.length > 0 };
          const gi = s.googleFonts.findIndex((f) => f.id === id);
          if (gi >= 0) {
            const googleFonts = s.googleFonts.slice();
            googleFonts[gi] = patch(googleFonts[gi]!);
            return { googleFonts };
          }
          const li = s.localFonts.findIndex((f) => f.id === id);
          if (li < 0) return s;
          const localFonts = s.localFonts.slice();
          localFonts[li] = patch(localFonts[li]!);
          return { localFonts };
        }),
      setCatalogLive: (value) => set({ catalogLive: value }),
      setScope: (scope) => set({ scope }),
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
        const font = findFont(id, get().localFonts, get().googleFonts);
        if (live || pending) {
          set((s) => ({
            ...withActivated(s.activated.filter((x) => x !== id)),
            ...withPending(s.pendingActivate.filter((x) => x !== id)),
          }));
          if (font) void syncFontOnSystem(font, false);
          return;
        }
        if (font?.source === "google") {
          set((s) => ({ ...withPending([...s.pendingActivate, id]) }));
          notifyIfUnusual(font, "activate");
          void syncFontOnSystem(font, true);
          return;
        }
        set(withActivated([...get().activated, id]));
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
          const drop = new Set(ids);
          set((s) => ({
            ...withActivated(s.activated.filter((id) => !drop.has(id))),
            ...withPending(s.pendingActivate.filter((id) => !drop.has(id))),
          }));
          const pack: FontRecord[] = [];
          for (const id of ids) {
            const font = findFont(id, local, google);
            if (font) pack.push(font);
          }
          void syncFontsOnSystem(pack, false);
          return;
        }
        const live = get().activatedSet;
        const pending = get().pendingSet;
        const googleIds: string[] = [];
        const localIds: string[] = [];
        const pack: FontRecord[] = [];
        for (const id of ids) {
          if (live.has(id) || pending.has(id)) continue;
          const font = findFont(id, local, google);
          if (!font) continue;
          pack.push(font);
          if (font.source === "google") googleIds.push(id);
          else localIds.push(id);
        }
        if (localIds.length) {
          set((s) => withActivated(Array.from(new Set([...s.activated, ...localIds]))));
        }
        if (googleIds.length) {
          set((s) => withPending(Array.from(new Set([...s.pendingActivate, ...googleIds]))));
        }
        if (pack.length) void syncFontsOnSystem(pack, true);
        if (pack.length) {
          const unusual = pack.find((f) => f.colorKind && f.colorKind !== "none");
          if (unusual) notifyIfUnusual(unusual, "activate");
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
        }));
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
        set({ ...withActivated(live), ...withPending(pending) });
      },
      selectFont: (id) =>
        set({ selectedId: id, inspectorOpen: Boolean(id) }),
      setInspectorOpen: (open) =>
        set({ inspectorOpen: open, selectedId: open ? get().selectedId : null }),
      setPreviewAxis: (id, tag, value) =>
        set((s) => {
          const prev = s.previewAxes[id];
          if (prev?.[tag] === value) return s;
          return {
            previewAxes: {
              ...s.previewAxes,
              [id]: { ...prev, [tag]: value },
            },
          };
        }),
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
      setCollectionWatch: (id, watchPath, autoActivate) =>
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
        })),
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
      deleteCollection: (id) => {
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
          void uninstallFontOnSystem(font);
          void unloadLocalFont(font.id);
          void idbDelete(font.id);
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
        set((s) => ({
          localFonts: s.localFonts.map((f) =>
            f.id === id ? { ...f, license, licenseUserSet: true } : f,
          ),
        })),
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
        const records: FontRecord[] = [];
        const newIds: string[] = [];
        const blobs: { id: string; blob: Blob }[] = [];
        const folderOf = new Map<string, string[]>();

        try {
          const parsedList = await (await import("./parse-pool")).parseFilesPool(files);
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

          const savedDisk = new Set<string>();
          for (let i = 0; i < parsedList.length; i += 1) {
            const item = parsedList[i]!;
            const file = files[i];
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
            blobs.push({
              id,
              blob: new Blob([parsed.buffer], { type: fontMime(parsed.fileName) }),
            });
            records.push({
              id,
              family: parsed.family,
              source: "local",
              category: parsed.category,
              weights: [parsed.weight],
              italic: parsed.italic,
              variable: parsed.variable,
              axes: parsed.axes.length ? parsed.axes : undefined,
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
              addedAt: Date.now(),
              license: parsed.license,
              licenseName: parsed.licenseName || undefined,
              kerningKey: parsed.kerningKey,
              colorKind: parsed.colorKind,
              originPath: opts?.originPaths?.[i],
            });
            newIds.push(id);
            added += 1;
            folderOf.set(
              id,
              folderPathForFile(file ?? ({ webkitRelativePath: "" } as File), opts?.collectionName),
            );
            if (!opts?.originPaths?.[i] && file && !savedDisk.has(file.name)) {
              savedDisk.add(file.name);
              void saveUploadToDisk({
                family: parsed.family,
                fileName: parsed.fileName || file.name,
                buffer: parsed.buffer,
              });
            }
            }
          }

          if (blobs.length) {
            try {
              await idbPutMany(blobs);
            } catch {
              failed += blobs.length;
              added = 0;
              records.length = 0;
              newIds.length = 0;
            }
          }

          let collectionId = opts?.collectionId;
          if (records.length) {
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
              for (const record of records) {
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
              const watchAuto =
                Boolean(opts?.originPaths?.length) &&
                Boolean(collections.find((c) => c.id === collectionId)?.autoActivate);
              const activateNew = !opts?.originPaths?.length || watchAuto;
              return {
                localFonts: [...records, ...s.localFonts],
                ...(activateNew
                  ? withActivated(Array.from(new Set([...s.activated, ...newIds])))
                  : {}),
                collections,
                scope: collectionId ? (`collection:${collectionId}` as const) : s.scope,
              };
            });
            const local = get().localFonts;
            const google = get().googleFonts;
            newIds.slice(0, 2).forEach((id) => {
              const font = findFont(id, local, google);
              if (font) void loadFont(font);
            });
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
        if (font) void removeUploadFromDisk(font);
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
      version: 2,
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      migrate: (persisted, from) => {
        const p = (persisted ?? {}) as Partial<PersistedSlice> & Record<string, unknown>;
        if (from < 2) {
          return {
            favorites: Array.isArray(p.favorites) ? p.favorites : [],
            activated: Array.isArray(p.activated) ? p.activated : [],
            pendingActivate: Array.isArray(p.pendingActivate) ? p.pendingActivate : [],
            collections: withoutBuiltinFolders(Array.isArray(p.collections) ? p.collections : []),
            customTags: p.customTags && typeof p.customTags === "object" ? p.customTags : {},
            localFonts: Array.isArray(p.localFonts) ? p.localFonts : [],
            preview: { ...DEFAULT_PREVIEW, ...(p.preview as PreviewSettings | undefined) },
            scope: (typeof p.scope === "string" ? p.scope : "all") as LibraryScope,
          } satisfies PersistedSlice;
        }
        return persisted as PersistedSlice;
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PersistedSlice>;
        const raw = stripLegacySeedActivation(p.activated ?? current.activated, (p.localFonts ?? current.localFonts).length);
        const known = new Set((p.localFonts ?? current.localFonts).map((f) => f.id));
        for (const f of current.googleFonts) known.add(f.id);
        const activated = raw.filter((id) => known.has(id));
        const pendingActivate = (p.pendingActivate ?? []).filter((id) => known.has(id) && !activated.includes(id));
        return {
          ...current,
          ...p,
          ...withActivated(activated),
          ...withPending(pendingActivate),
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
          scope: p.scope ?? current.scope ?? "all",
        };
      },
      partialize: (s): PersistedSlice => ({
        favorites: s.favorites,
        activated: s.activated,
        pendingActivate: [],
        collections: s.collections,
        customTags: s.customTags,
        localFonts: s.localFonts,
        preview: s.preview,
        scope: s.scope,
      }),
    },
  ),
);

export function findFont(
  id: string,
  localFonts: FontRecord[],
  googleFonts: FontRecord[] = GOOGLE_FONTS,
): FontRecord | undefined {
  return FONT_BY_ID.get(id) ?? localFonts.find((f) => f.id === id) ?? googleFonts.find((f) => f.id === id);
}

export function allFonts(
  localFonts: FontRecord[],
  googleFonts: FontRecord[] = GOOGLE_FONTS,
): FontRecord[] {
  return [...localFonts, ...googleFonts];
}

export function tagsFor(font: FontRecord, customTags: Record<string, string[]>): string[] {
  const extra = customTags[font.id] ?? [];
  return Array.from(new Set([...font.tags, ...extra]));
}

export async function findDuplicates(
  localFonts: FontRecord[],
  googleFonts: FontRecord[] = [],
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
  const seenFamily = new Set<string>();
  for (const font of localFonts) {
    const name = font.family.trim().toLowerCase();
    if (seenFamily.has(name)) continue;
    const google = googleByFamily.get(name);
    if (!google) continue;
    seenFamily.add(name);
    const locals = localFonts.filter((f) => f.family.trim().toLowerCase() === name);
    groups.push({ key: `gl:${name}`, reason: "family-weight", fonts: [google, ...locals] });
  }

  return groups;
}

export function matchesQuery(
  font: FontRecord,
  query: string,
  customTags: Record<string, string[]>,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const tokens = q.split(/\s+/);
  const hay = [
    font.family,
    font.source,
    font.category,
    ...tagsFor(font, customTags),
    font.variable ? "variable" : "",
    font.italic ? "italic" : "",
    font.fileName ?? "",
    licenseSearchHay(font),
  ]
    .join(" ")
    .toLowerCase();

  return tokens.every((token) => {
    if (token.startsWith("weight:")) {
      const w = Number(token.slice(7));
      return font.weights.includes(w) || (font.variable && !Number.isNaN(w));
    }
    if (token === "variable") return font.variable;
    if (token === "italic") return font.italic;
    if (token.startsWith("tag:")) return tagsFor(font, customTags).includes(token.slice(4));
    if (token.startsWith("license:")) return fontLicense(font) === token.slice(8);
    return hay.includes(token);
  });
}

export function filterLibrary(
  fonts: FontRecord[],
  scope: LibraryScope,
  query: string,
  favorites: string[],
  activated: string[],
  collections: Collection[],
  customTags: Record<string, string[]>,
): FontRecord[] {
  let list = fonts;
  if (scope === "activated") {
    const on = new Set(activated);
    list = list.filter((f) => on.has(f.id));
  } else if (scope === "favorites") {
    const fav = new Set(favorites);
    list = list.filter((f) => fav.has(f.id));
  } else if (scope === "uploaded") list = list.filter((f) => f.source === "local");
  else if (scope === "google") list = list.filter((f) => f.source === "google");
  else if (scope.startsWith("collection:")) {
    const ids = collectFolderFontIds(collections, scope.slice(11));
    list = list.filter((f) => ids.has(f.id));
  } else if (scope.startsWith("category:")) {
    const cat = scope.slice(9);
    list = list.filter((f) => f.category === cat);
  } else if (scope.startsWith("tag:")) {
    const tag = scope.slice(4);
    list = list.filter((f) => tagsFor(f, customTags).includes(tag));
  } else if (scope.startsWith("license:")) {
    const license = scope.slice(8) as FontLicense;
    list = list.filter((f) => fontLicense(f) === license);
  }
  if (query.trim()) list = list.filter((f) => matchesQuery(f, query, customTags));
  return list;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

export function sortLibrary(fonts: FontRecord[], sort: LibrarySort = "name-asc"): FontRecord[] {
  const copy = [...fonts];
  copy.sort((a, b) => {
    switch (sort) {
      case "name-desc":
        return collator.compare(b.family, a.family) || a.id.localeCompare(b.id);
      case "popular":
        return a.popularity - b.popularity || collator.compare(a.family, b.family);
      case "recent":
        return (b.addedAt ?? 0) - (a.addedAt ?? 0) || collator.compare(a.family, b.family);
      case "name-asc":
      default:
        return collator.compare(a.family, b.family) || a.id.localeCompare(b.id);
    }
  });
  return copy;
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
