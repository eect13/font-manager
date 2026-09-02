import { toast } from "sonner";
import { FONT_BY_ID, GOOGLE_DIRECTORY, GOOGLE_FONTS, familyKey, googleFontId, replaceGoogleCatalog } from "./catalog";
import { classifyLicenseText, licenseFromCode } from "./license";
import { guessGoogleColorKind } from "./color-font";
import { tagsForGoogleFamily } from "./style-tags";
import { idbGet, idbPut } from "./idb";
import styleMeta from "./google-style.json";
import type { FontCategory, FontLicense, FontRecord } from "./types";

interface FontsourceItem {
  family: string;
  category?: string;
  weights?: number[];
  styles?: string[];
  variable?: boolean;
  license?: string;
  type?: string;
  subsets?: string[];
}

const CATEGORY: Record<string, FontCategory> = {
  "sans-serif": "sans",
  serif: "serif",
  display: "display",
  handwriting: "handwriting",
  monospace: "mono",
  other: "other",
  icons: "icons",
};

const FONTSOURCE_LIST = "https://api.fontsource.org/v1/fonts";
const GOOGLE_META = "https://fonts.google.com/metadata/fonts";
const CATALOG_CACHE_ID = "catalog:live";
const BUNDLED_COUNT = GOOGLE_FONTS.length;
const FETCH_MS = 10_000;
const STALE_MS = 24 * 60 * 60 * 1000;
const IDLE_MS = 4_000;
const IDLE_CAP_MS = 8_000;

export type CatalogSyncResult = {
  count: number;
  added: number;
  skipped?: boolean;
};

type CatalogCache = {
  v: 1;
  savedAt: number;
  fonts: FontRecord[];
};

type CatalogSyncSnap = {
  busy: boolean;
  syncedAt: number;
};

let busy = false;
let syncedAt = 0;
let snap: CatalogSyncSnap = { busy: false, syncedAt: 0 };
const listeners = new Set<() => void>();
let inflight: Promise<CatalogSyncResult | null> | null = null;

function emitSync() {
  snap = { busy, syncedAt };
  for (const fn of listeners) fn();
}

export function subscribeCatalogSync(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getCatalogSyncState(): CatalogSyncSnap {
  return snap;
}

function setBusy(value: boolean) {
  if (busy === value) return;
  busy = value;
  emitSync();
}

function markSynced(at: number) {
  if (syncedAt === at) return;
  syncedAt = at;
  emitSync();
}

function licenseFromSource(raw?: string): { license: FontLicense; licenseName: string } {
  const coded = licenseFromCode(raw);
  if (coded) return coded;
  const hit = classifyLicenseText(raw ?? "");
  if (hit.license === "free") return hit;
  const n = (raw ?? "").toLowerCase();
  if (n.startsWith("apache")) return { license: "free", licenseName: "Apache License 2.0" };
  if (n.startsWith("ufl") || n.includes("ubuntu")) {
    return { license: "free", licenseName: "Ubuntu Font License 1.0" };
  }
  return { license: "free", licenseName: "SIL Open Font License 1.1" };
}

function catalogOf(family: string, dir: Set<string> = GOOGLE_DIRECTORY): "google" | "other" {
  return dir.has(familyKey(family)) ? "google" : "other";
}

function fromFontsource(item: FontsourceItem, popularity: number, existing?: FontRecord, dir: Set<string> = GOOGLE_DIRECTORY): FontRecord {
  const official = (styleMeta as Record<string, string[]>)[item.family] ?? [];
  const { license, licenseName } = licenseFromSource(item.license);
  const category = CATEGORY[item.category ?? ""] ?? existing?.category ?? "sans";
  const extra = [...official, ...(existing?.tags ?? [])];
  if (item.subsets?.includes("emoji")) extra.push("emoji");
  return {
    id: googleFontId(item.family),
    family: item.family,
    source: "google",
    catalog: catalogOf(item.family, dir),
    category,
    weights: item.weights?.length ? item.weights : existing?.weights ?? [400],
    italic: item.styles?.includes("italic") ?? existing?.italic ?? false,
    variable: Boolean(item.variable) || Boolean(existing?.variable),
    tags: tagsForGoogleFamily(item.family, category, extra),
    popularity: existing?.popularity ?? popularity,
    license,
    licenseName,
    colorKind: existing?.colorKind ?? guessGoogleColorKind(item.family),
  };
}

function slimRecord(font: FontRecord): FontRecord {
  return {
    id: font.id,
    family: font.family,
    source: "google",
    catalog: font.catalog,
    category: font.category,
    weights: font.weights,
    italic: font.italic,
    variable: font.variable,
    tags: font.tags,
    popularity: font.popularity,
    license: font.license,
    licenseName: font.licenseName,
    colorKind: font.colorKind,
  };
}

function validCachedFonts(fonts: unknown): fonts is FontRecord[] {
  if (!Array.isArray(fonts) || fonts.length < BUNDLED_COUNT) return false;
  return fonts.every((font) => {
    if (!font || typeof font !== "object") return false;
    const rec = font as FontRecord;
    return (
      typeof rec.family === "string" &&
      rec.family.length > 0 &&
      typeof rec.id === "string" &&
      rec.id.startsWith("g:") &&
      typeof rec.category === "string" &&
      Array.isArray(rec.weights)
    );
  });
}

async function saveCatalogCache(fonts: FontRecord[]) {
  try {
    const payload: CatalogCache = { v: 1, savedAt: Date.now(), fonts: fonts.map(slimRecord) };
    await idbPut(CATALOG_CACHE_ID, new Blob([JSON.stringify(payload)], { type: "application/json" }));
  } catch {
    /* quota — shipped snapshot still boots */
  }
}

function withOfficialLanes(fonts: FontRecord[], dir: Set<string> = GOOGLE_DIRECTORY): FontRecord[] {
  return fonts.map((font) => ({
    ...font,
    catalog: catalogOf(font.family, dir),
  }));
}

function applyLiveCatalog(fonts: FontRecord[], dir: Set<string> = GOOGLE_DIRECTORY) {
  replaceGoogleCatalog(withOfficialLanes(fonts, dir));
  void import("./store").then(({ useFontStore }) => {
    useFontStore.getState().setGoogleFonts(GOOGLE_FONTS.slice());
    useFontStore.getState().setCatalogLive(true);
  });
}

export async function loadCachedCatalog(): Promise<boolean> {
  try {
    const blob = await idbGet(CATALOG_CACHE_ID);
    if (!blob || typeof blob.text !== "function") return false;
    const parsed = JSON.parse(await blob.text()) as Partial<CatalogCache>;
    if (parsed.v !== 1 || !validCachedFonts(parsed.fonts)) return false;
    const fonts = parsed.fonts.map((font) => ({
      ...font,
      source: "google" as const,
      id: font.id.startsWith("g:") ? font.id : googleFontId(font.family),
      catalog: catalogOf(font.family),
      weights: font.weights?.length ? font.weights : [400],
    }));
    applyLiveCatalog(fonts);
    if (typeof parsed.savedAt === "number" && parsed.savedAt > 0) markSynced(parsed.savedAt);
    return true;
  } catch {
    return false;
  }
}

async function fetchFontsourceList(force: boolean): Promise<FontsourceItem[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await fetch(FONTSOURCE_LIST, {
      signal: ctrl.signal,
      cache: force ? "no-store" : "default",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as FontsourceItem[];
    if (!Array.isArray(data) || data.length < 1000) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoogleDirectory(): Promise<Set<string>> {
  const dir = GOOGLE_DIRECTORY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await fetch(GOOGLE_META, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) return dir;
    const text = await res.text();
    const json = JSON.parse(text.replace(/^\)\]\}'\n?/, "")) as {
      familyMetadataList?: { family?: string }[];
    };
    for (const item of json.familyMetadataList ?? []) {
      if (item.family) dir.add(familyKey(item.family));
    }
  } catch {
    /* shipped directory still classifies */
  } finally {
    clearTimeout(timer);
  }
  return dir;
}

export async function refreshGoogleCatalog(force = false): Promise<CatalogSyncResult | null> {
  const [data, dir] = await Promise.all([fetchFontsourceList(force), fetchGoogleDirectory()]);
  if (!data) return null;

  const rows = data.filter((item) => item.family);
  const indexByFamily = new Map(GOOGLE_FONTS.map((font, i) => [font.family, i]));
  const next = GOOGLE_FONTS.slice();
  let added = 0;

  for (const item of rows) {
    if (!item.family) continue;
    const idx = indexByFamily.get(item.family);
    if (idx !== undefined) {
      const existing = next[idx]!;
      next[idx] = {
        ...existing,
        category: CATEGORY[item.category ?? ""] ?? existing.category,
        weights: item.weights?.length ? item.weights : existing.weights,
        italic: item.styles?.includes("italic") ?? existing.italic,
        variable: Boolean(item.variable) || existing.variable,
        tags: tagsForGoogleFamily(
          item.family,
          CATEGORY[item.category ?? ""] ?? existing.category,
          [...((styleMeta as Record<string, string[]>)[item.family] ?? []), ...existing.tags],
        ),
        ...licenseFromSource(item.license),
        catalog: catalogOf(item.family, dir),
      };
      continue;
    }
    added += 1;
    const record = fromFontsource(item, 400 + next.length, undefined, dir);
    indexByFamily.set(item.family, next.length);
    next.push(record);
  }

  if (next.length < GOOGLE_FONTS.length) {
    return { count: GOOGLE_FONTS.length, added: 0 };
  }
  applyLiveCatalog(next, dir);
  markSynced(Date.now());
  void saveCatalogCache(next);
  return { count: next.length, added };
}

function notifyCatalog(result: CatalogSyncResult, force: boolean) {
  if (result.skipped) return;
  if (result.added > 0) {
    toast.success(
      `Catalog updated — ${result.added.toLocaleString()} new typeface${result.added === 1 ? "" : "s"}`,
      {
        description: `${result.count.toLocaleString()} families. Google drawer is fonts.google.com (${GOOGLE_DIRECTORY.size.toLocaleString()}), not Fontsource's type flag. Files on disk are unchanged.`,
      },
    );
    return;
  }
  if (force) {
    toast.message("Catalog is current", {
      description: `${result.count.toLocaleString()} typefaces. TTF files are unchanged — Retry a family to pull a new package.`,
    });
  }
}

export function syncFontCatalog(opts?: {
  force?: boolean;
  notify?: boolean;
}): Promise<CatalogSyncResult | null> {
  const force = Boolean(opts?.force);
  const notify = Boolean(opts?.notify);
  if (inflight) return inflight;
  setBusy(true);
  inflight = (async () => {
    const result = await refreshGoogleCatalog(force);
    if (!result) {
      if (notify) {
        toast.error("Could not reach Fontsource", {
          description: "Using the shipped list. Try again when you are online.",
        });
      }
      return null;
    }
    if (result.added > 0 || notify) notifyCatalog(result, notify);
    return result;
  })()
    .catch(() => null)
    .finally(() => {
      inflight = null;
      setBusy(false);
    });
  return inflight;
}

export function scheduleCatalogSync(): () => void {
  let cancelled = false;
  let idleId = 0;
  let timeoutId = 0;
  const start = () => {
    if (cancelled) return;
    if (syncedAt && Date.now() - syncedAt < STALE_MS) return;
    void syncFontCatalog({ force: false, notify: false });
  };
  timeoutId = window.setTimeout(() => {
    if (cancelled) return;
    if (typeof requestIdleCallback === "function") {
      idleId = requestIdleCallback(start, { timeout: IDLE_CAP_MS });
    } else {
      start();
    }
  }, IDLE_MS);
  return () => {
    cancelled = true;
    if (idleId && typeof cancelIdleCallback === "function") cancelIdleCallback(idleId);
    if (timeoutId) clearTimeout(timeoutId);
  };
}

export function googleFontLookup(id: string): FontRecord | undefined {
  return FONT_BY_ID.get(id);
}
