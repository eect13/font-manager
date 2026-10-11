import { toast } from "sonner";
import { FONT_BY_ID, GOOGLE_DIRECTORY, GOOGLE_FONTS, familyKey, googleFontId, isGoogleCatalog, replaceGoogleCatalog } from "./catalog";
import { CATALOG_CACHE_VERSION, healCachedCatalogFont } from "./heal-catalog";
import { idbGet, idbPut } from "./idb";
import type { FontRecord } from "./types";
import { APP_VERSION } from "../../version";

const CATALOG_CACHE_ID = "catalog:live";
const BUNDLED_COUNT = GOOGLE_FONTS.length;
const STALE_MS = 24 * 60 * 60 * 1000;
const IDLE_MS = 4_000;
const IDLE_CAP_MS = 8_000;

export type CatalogSyncResult = {
  count: number;
  added: number;
  skipped?: boolean;
};

type CatalogCache = {
  v: 1 | typeof CATALOG_CACHE_VERSION;
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

function catalogOf(family: string, dir: Set<string> = GOOGLE_DIRECTORY): "google" | "other" {
  return dir.has(familyKey(family)) ? "google" : "other";
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
    catalogVariable: font.catalogVariable,
    variable: false,
    tags: font.tags,
    popularity: font.popularity,
    license: font.license,
    licenseName: font.licenseName,
    colorKind: font.colorKind,
  };
}

export { CATALOG_CACHE_VERSION, healCachedCatalogFont } from "./heal-catalog";

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
    const payload: CatalogCache = { v: CATALOG_CACHE_VERSION, savedAt: Date.now(), fonts: fonts.map(slimRecord) };
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
  const official = withOfficialLanes(fonts, dir).filter(isGoogleCatalog);
  replaceGoogleCatalog(official.length ? official : GOOGLE_FONTS.filter(isGoogleCatalog));
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
    if (parsed.v !== 1 && parsed.v !== CATALOG_CACHE_VERSION) return false;
    if (!validCachedFonts(parsed.fonts)) return false;
    const bundledVar = new Map(GOOGLE_FONTS.map((font) => [font.family.toLowerCase(), font] as const));
    const fonts = parsed.fonts
      .map((font) => {
        const bundled = bundledVar.get(font.family.toLowerCase());
        const healed = healCachedCatalogFont(font, bundled);
        return {
          ...font,
          source: "google" as const,
          id: font.id.startsWith("g:") ? font.id : googleFontId(font.family),
          catalog: catalogOf(font.family),
          weights: font.weights?.length ? font.weights : [400],
          catalogVariable: healed.catalogVariable,
          variable: healed.variable,
        };
      })
      .filter(isGoogleCatalog);
    applyLiveCatalog(fonts);
    if (typeof parsed.savedAt === "number" && parsed.savedAt > 0) markSynced(parsed.savedAt);
    return true;
  } catch {
    return false;
  }
}

/** Google Fonts is the only remote catalog. Refresh confirms the shipped list and drops leftover Fontsource cards. */
export async function refreshGoogleCatalog(_force = false): Promise<CatalogSyncResult | null> {
  const official = GOOGLE_FONTS.filter(isGoogleCatalog);
  applyLiveCatalog(official);
  markSynced(Date.now());
  return { count: official.length, added: 0 };
}

function notifyCatalog(result: CatalogSyncResult, force: boolean) {
  if (result.skipped) return;
  const summary = `Google Fonts ${result.count.toLocaleString()}`;
  if (result.added > 0) {
    toast.success(
      `Catalog updated — ${result.added.toLocaleString()} new typeface${result.added === 1 ? "" : "s"}`,
      {
        description: `${summary}. Files on disk are unchanged.`,
      },
    );
    return;
  }
  if (force) {
    toast.message("Catalog is current", {
      description: `${summary}. TTF files are unchanged — Retry a family to pull a new package.`,
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
        toast.error("Could not refresh Google Fonts", {
          description: "Using the shipped list. Try again when you are online.",
        });
      }
      return null;
    }
    if (result.added > 0 || notify) notifyCatalog(result, notify);
    if (notify) {
      // Always probe latest release on Refresh; only toast when behind (avoid double noise).
      const rel = await checkLatestGitHubRelease();
      if (rel.updateAvailable && rel.latest) {
        toast.message(`App update available — ${rel.latest}`, {
          description: `Installed ${rel.installed}. ${rel.releaseUrl ?? "See GitHub releases"}.`,
        });
      }
    }
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

export type AppReleaseCheck = {
  installed: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
};

/** Compare installed app version to GitHub latest release tag (v1.0.x). */
export async function checkLatestGitHubRelease(): Promise<AppReleaseCheck> {
  const installed = APP_VERSION;
  const releaseUrl = "https://github.com/eect13/font-manager/releases/latest";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch("https://api.github.com/repos/eect13/font-manager/releases/latest", {
      signal: ctrl.signal,
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { installed, latest: null, updateAvailable: false, releaseUrl };
    }
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const tag = (data.tag_name || "").replace(/^v/i, "").trim();
    const latest = tag || null;
    const updateAvailable = Boolean(latest && latest !== installed && latest.localeCompare(installed, undefined, { numeric: true, sensitivity: "base" }) > 0);
    return {
      installed,
      latest,
      updateAvailable,
      releaseUrl: data.html_url || releaseUrl,
    };
  } catch {
    return { installed, latest: null, updateAvailable: false, releaseUrl };
  }
}
