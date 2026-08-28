import type { FontRecord } from "./types";
import { idbGet, idbPutPreview, previewCacheId } from "./idb";
import { isEmojiFamily } from "./emoji";
import { axesForFont } from "./axes";
import { isSpecialPreviewFont, notifyIfUnusual } from "./color-font";
import { cssFamilyStack as stackFor } from "./fallback";
import { scriptProbe, scriptSubset } from "./scripts";
import { GOOGLE_CATALOG_META } from "./catalog";
import { toast } from "sonner";

async function inTauri() {
  try {
    const api = await import("@tauri-apps/api/core");
    if (typeof api.isTauri === "function") return api.isTauri();
  } catch {
    /* web */
  }
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

async function faceFromBuffer(
  family: string,
  buffer: ArrayBuffer,
  opts: { style?: "normal" | "italic"; variable?: boolean; weight?: string; unicodeRange?: string } = {},
) {
  if (typeof document === "undefined") return false;
  const copy = buffer.slice(0);
  const style = opts.style ?? "normal";
  const desc: FontFaceDescriptors = {
    display: "swap",
    style,
    weight: opts.weight ?? (opts.variable ? "100 900" : "400"),
    ...(opts.variable ? { stretch: "50% 200%" } : {}),
    ...(opts.unicodeRange ? { unicodeRange: opts.unicodeRange } : {}),
  };
  try {
    const face = new FontFace(family, copy, desc);
    await face.load();
    replaceStaticIfVariable(family, opts.variable);
    document.fonts.add(face);
    rememberFace(family, face);
    return true;
  } catch {
    const url = URL.createObjectURL(new Blob([copy]));
    try {
      const face = new FontFace(family, `url(${url})`, desc);
      await face.load();
      replaceStaticIfVariable(family, opts.variable, style);
      document.fonts.add(face);
      rememberFace(family, face);
      specialFaces.set(family, face);
      return true;
    } catch {
      URL.revokeObjectURL(url);
      return false;
    }
  }
}

const familyFaces = new Map<string, FontFace[]>();
const faceOrder: string[] = [];
/** Drop oldest FontFace families so 2k+ Activate does not grow document.fonts without bound. */
const FACE_LRU = 384;

function evictFamily(family: string) {
  for (const face of familyFaces.get(family) ?? []) {
    try {
      document.fonts.delete(face);
    } catch {
      /* ignore */
    }
  }
  familyFaces.delete(family);
}

function rememberFace(family: string, face: FontFace) {
  const list = familyFaces.get(family) ?? [];
  list.push(face);
  familyFaces.set(family, list);
  const at = faceOrder.indexOf(family);
  if (at >= 0) faceOrder.splice(at, 1);
  faceOrder.push(family);
  while (faceOrder.length > FACE_LRU) {
    const old = faceOrder.shift();
    if (old && old !== family) evictFamily(old);
  }
}

function replaceStaticIfVariable(family: string, variable?: boolean, style?: string) {
  if (!variable) return;
  const keep: FontFace[] = [];
  for (const face of familyFaces.get(family) ?? []) {
    const sameStyle = !style || face.style === style;
    if (!sameStyle) {
      keep.push(face);
      continue;
    }
    try {
      document.fonts.delete(face);
    } catch {
      /* ignore */
    }
  }
  familyFaces.set(family, keep);
}

function vfWeight(font: FontRecord) {
  const axis = axesForFont(font).find((a) => a.tag === "wght");
  if (axis) return `${Math.round(axis.min)} ${Math.round(axis.max)}`;
  return "100 900";
}

const LATIN_RANGE =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BD, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2212, U+2215, U+FEFF, U+FFFD";

function latinRangeIfNeeded(source?: string) {
  if (!source) return undefined;
  return /latin[-_.]/i.test(source) ? LATIN_RANGE : undefined;
}

const probedIds = new Set<string>();

async function rememberFileAxes(font: FontRecord, buffer: ArrayBuffer): Promise<boolean | null> {
  if (probedIds.has(font.id) && font.axes !== undefined) return font.axes.length > 0;
  try {
    const { axesFromFamily, axesFromBuffer } = await import("./parse-font");
    const axes = (await axesFromFamily(font.family)) ?? (await axesFromBuffer(buffer));
    if (axes === null) return null;
    if (!axes.length) return false;
    probedIds.add(font.id);
    const { useFontStore } = await import("./store");
    useFontStore.getState().patchFontAxes(font.id, axes);
    font.axes = axes;
    font.variable = axes.length > 0;
    return axes.length > 0;
  } catch {
    return null;
  }
}

let diskFamilyCache: Set<string> | null = null;

/** Desktop: skip IPC for Google families that are not on disk. */
export function noteDiskFamilies(names: string[]) {
  diskFamilyCache = new Set();
  for (const n of names) {
    const t = n.trim();
    if (!t) continue;
    diskFamilyCache.add(t.toLowerCase());
    diskFamilyCache.add(slugFamily(t));
  }
}

function likelyOnDisk(font: FontRecord) {
  if (font.source === "local") return true;
  if (!diskFamilyCache) return false;
  const fam = font.family.trim().toLowerCase();
  return diskFamilyCache.has(fam) || diskFamilyCache.has(slugFamily(font.family));
}

async function loadGoogleFromLocal(font: FontRecord, mode: FontLoadMode = "preview"): Promise<boolean> {
  if (typeof document === "undefined") return false;
  if ((await inTauri()) && likelyOnDisk(font)) {
    try {
      const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");
      const path = await invoke<string>("read_family_font", { family: font.family });
      const { axesFromFamily } = await import("./parse-font");
      const axes = await axesFromFamily(font.family);
      if (axes?.length) {
        probedIds.add(font.id);
        const { useFontStore } = await import("./store");
        useFontStore.getState().patchFontAxes(font.id, axes);
        font.axes = axes;
        font.variable = true;
      }
      const isVf = Boolean(axes?.length) || font.variable;
      const url = convertFileSrc(path);
      const face = new FontFace(font.family, `url(${JSON.stringify(url)})`, {
        display: "swap",
        style: "normal",
        weight: isVf ? vfWeight(font) : "400",
        ...(isVf ? { stretch: "50% 200%" } : {}),
        ...(latinRangeIfNeeded(path) ? { unicodeRange: latinRangeIfNeeded(path) } : {}),
      });
      await face.load();
      replaceStaticIfVariable(font.family, isVf);
      document.fonts.add(face);
      rememberFace(font.family, face);
      loadedGoogle.set(font.id, isVf ? "full" : "preview");
      return true;
    } catch {
      /* try byte read */
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const path = await invoke<string>("read_family_font", { family: font.family });
      const bytes = await readFile(path);
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const probed = await rememberFileAxes(font, copy);
      const isVf = probed === true || font.variable;
      if (
        await faceFromBuffer(font.family, copy, {
          variable: isVf,
          weight: isVf ? vfWeight(font) : "400",
          unicodeRange: latinRangeIfNeeded(path),
        })
      ) {
        loadedGoogle.set(font.id, isVf ? "full" : "preview");
        return true;
      }
    } catch {
      /* not on disk */
    }
  }
  if (font.variable) return false;
  try {
    const blob = await idbGet(previewCacheId(font.id));
    if (!blob) return false;
    const buf = await blob.arrayBuffer();
    const probed = await rememberFileAxes(font, buf);
    const isVf = probed === true;
    if (await faceFromBuffer(font.family, buf, { variable: isVf, weight: isVf ? vfWeight(font) : "400" })) {
      loadedGoogle.set(font.id, isVf ? "full" : "preview");
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function fetchFaceAndCache(
  font: FontRecord,
  urls: string[],
  style: "normal" | "italic" = "normal",
  weight = 400,
): Promise<boolean> {
  if (typeof document === "undefined") return false;
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 256) continue;
      const probed = await rememberFileAxes(font, buf);
      const isVf = probed === true || (probed === null && font.variable);
      if (
        !(await faceFromBuffer(font.family, buf, {
          style,
          variable: isVf,
          weight: isVf ? vfWeight(font) : String(weight),
          unicodeRange: latinRangeIfNeeded(url),
        }))
      ) {
        continue;
      }
      if (style === "normal" && weight === 400 && !font.variable) {
        void idbPutPreview(font.id, new Blob([buf]));
      }
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/** Preview = latin 400 + swap, visible cards only. Full = all weights for playground/glyphs. */
export type FontLoadMode = "preview" | "full";

const previewFailNotified = new Set<string>();
const loadedGoogle = new Map<string, FontLoadMode>();
const loadedLocal = new Set<string>();
const inflight = new Map<string, Promise<void>>();
const googleLinks = new Map<string, HTMLElement>();
const localFaces = new Map<string, { face: FontFace; url: string }>();
const specialFaces = new Map<string, FontFace>();

const MAX_CSS = 16;
let cssActive = 0;
const cssWait: Array<() => void> = [];

function withCssSlot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      cssActive += 1;
      fn()
        .then(resolve, reject)
        .finally(() => {
          cssActive -= 1;
          const next = cssWait.shift();
          if (next) next();
        });
    };
    if (cssActive < MAX_CSS) run();
    else cssWait.push(run);
  });
}

function slugFamily(family: string) {
  return family
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function cssStamp() {
  return (GOOGLE_CATALOG_META.updated || "latest").replace(/-/g, "");
}

function googleCssHref(param: string, display: string, subset?: string) {
  let href = `https://fonts.googleapis.com/css2?${param}&display=${display}&v=${cssStamp()}`;
  if (subset) href += `&text=${encodeURIComponent(subset.slice(0, 72))}`;
  return href;
}

function previewFamilyParams(font: FontRecord): string[] {
  const family = font.family.replace(/ /g, "+");
  if (isSpecialPreviewFont(font)) return [`family=${family}`];
  if (font.variable) {
    const wght = axesForFont(font).find((a) => a.tag === "wght");
    const min = Math.round(wght?.min ?? 100);
    const max = Math.round(wght?.max ?? 900);
    if (font.italic) return [`family=${family}:ital,wght@0,${min}..${max};1,${min}..${max}`];
    return [`family=${family}:wght@${min}..${max}`];
  }
  if (font.italic) return [`family=${family}:ital,wght@0,400;1,400`, `family=${family}:ital@1`];
  return [`family=${family}:wght@400`];
}

function googleFamilyParam(font: FontRecord, mode: FontLoadMode): string {
  const family = font.family.replace(/ /g, "+");
  if (isSpecialPreviewFont(font)) {
    return `family=${family}`;
  }
  if (mode === "preview") {
    return `family=${family}:wght@400`;
  }
  const axes = axesForFont(font).filter((axis) => axis.tag !== "ital");
  if (font.variable && axes.length) {
    const tags = axes.map((a) => a.tag).sort();
    const ranges = tags
      .map((tag) => {
        const axis = axes.find((a) => a.tag === tag)!;
        return `${axis.min}..${axis.max}`;
      })
      .join(",");
    if (font.italic) {
      return `family=${family}:ital,${tags.join(",")}@0,${ranges};1,${ranges}`;
    }
    return `family=${family}:${tags.join(",")}@${ranges}`;
  }
  const weights = font.weights?.length ? font.weights : [400];
  const italic = font.italic;

  if (font.variable) {
    const min = Math.min(...weights);
    const max = Math.max(...weights);
    if (italic) {
      return `family=${family}:ital,wght@0,${min}..${max};1,${min}..${max}`;
    }
    return `family=${family}:wght@${min}..${max}`;
  }

  if (italic) {
    const pairs: string[] = [];
    for (const axis of [0, 1]) {
      for (const w of weights) pairs.push(`${axis},${w}`);
    }
    return `family=${family}:ital,wght@${pairs.join(";")}`;
  }

  if (weights.length === 1 && weights[0] === 400) {
    return `family=${family}`;
  }
  return `family=${family}:wght@${weights.join(";")}`;
}

function injectGoogleCss(href: string, key: string): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  const existing = googleLinks.get(key);
  if (existing) return Promise.resolve();

  return withCssSlot(async () => {
    const cacheId = `css:${key}`;
    try {
      const { idbGet, idbPut } = await import("./idb");
      const cached = await idbGet(cacheId);
      let text = cached ? await cached.text() : "";
      if (!text) {
        const res = await fetch(href);
        if (res.ok) text = await res.text();
        if (text.length > 80 && text.length < 400_000) {
          void idbPut(cacheId, new Blob([text], { type: "text/css" }));
        }
      }
      if (text) {
        const style = document.createElement("style");
        style.dataset.fontKey = key;
        style.textContent = text;
        document.head.appendChild(style);
        googleLinks.set(key, style);
        return;
      }
    } catch {
      /* network / idb — fall through to <link> */
    }
    await new Promise<void>((resolve) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.fontKey = key;
      link.onload = () => resolve();
      link.onerror = () => resolve();
      document.head.appendChild(link);
      googleLinks.set(key, link);
      window.setTimeout(() => resolve(), 1400);
    });
  });
}

function familyLoaded(family: string, probe: string) {
  if (typeof document === "undefined" || !document.fonts?.check) return false;
  try {
    return document.fonts.check(`24px "${family}"`, probe);
  } catch {
    return false;
  }
}

function waitForFamily(family: string, probe: string, ms: number): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return Promise.resolve();
  return Promise.race([
    document.fonts.load(`24px "${family}"`, probe).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
  ]).then(() => undefined);
}

function latinSourceUrls(family: string, italic = false, weight = 400) {
  const slug = slugFamily(family);
  const subset = scriptSubset(family);
  const faces = subset === "latin" ? [`latin-${weight}-${italic ? "italic" : "normal"}`] : [`${subset}-${weight}-normal`, `latin-${weight}-${italic ? "italic" : "normal"}`];
  const urls: string[] = [];
  for (const face of faces) {
    urls.push(
      `https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/${face}.woff2`,
      `https://cdn.jsdelivr.net/npm/@fontsource/${slug}/files/${slug}-${face}.woff2`,
      `https://unpkg.com/@fontsource/${slug}/files/${slug}-${face}.woff2`,
    );
  }
  return urls;
}

function variableSourceUrls(family: string, italic = false) {
  const slug = slugFamily(family);
  const subset = scriptSubset(family);
  const faces =
    subset === "latin"
      ? [italic ? "latin-wght-italic" : "latin-wght-normal"]
      : [`${subset}-wght-normal`, italic ? "latin-wght-italic" : "latin-wght-normal"];
  const urls: string[] = [];
  for (const face of faces) {
    urls.push(
      `https://cdn.jsdelivr.net/fontsource/fonts/${slug}:vf@latest/${face}.woff2`,
      `https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/${face}.woff2`,
      `https://cdn.jsdelivr.net/npm/@fontsource-variable/${slug}/files/${slug}-${face}.woff2`,
      `https://unpkg.com/@fontsource-variable/${slug}/files/${slug}-${face}.woff2`,
    );
  }
  return urls;
}

function specialSourceUrls(family: string) {
  const slug = slugFamily(family);
  const urls = [
    `https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/emoji-400-normal.woff2`,
    `https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/latin-400-normal.woff2`,
    `https://cdn.jsdelivr.net/npm/@fontsource/${slug}/files/${slug}-latin-400-normal.woff2`,
  ];
  if (slug === "noto-color-emoji") {
    urls.unshift(
      "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/Noto-COLRv1.ttf",
      "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf",
    );
  }
  return urls;
}

async function loadFaceFromUrls(family: string, urls: string[]) {
  if (typeof document === "undefined") return false;
  for (const url of urls) {
    try {
      const face = new FontFace(family, `url("${url}")`, { display: "block" });
      await face.load();
      document.fonts.add(face);
      specialFaces.set(family, face);
      return true;
    } catch {
      /* next url */
    }
  }
  return false;
}

function dropCssForFont(id: string) {
  for (const [key, link] of [...googleLinks.entries()]) {
    if (!key.startsWith(`${id}:`)) continue;
    try {
      link.remove();
    } catch {
      /* ignore */
    }
    googleLinks.delete(key);
  }
}

function cssKey(id: string, mode: FontLoadMode) {
  return `${id}:${mode}`;
}

function ensureCatalogCss(font: FontRecord) {
  const family = font.family.replace(/ /g, "+");
  const param = font.variable ? googleFamilyParam(font, "full") : `family=${family}`;
  return injectGoogleCss(googleCssHref(param, "swap"), `cover:${font.id}`);
}

export function loadGoogleFont(font: FontRecord, mode: FontLoadMode = "preview"): Promise<void> {
  if (font.source !== "google") return Promise.resolve();
  const have = loadedGoogle.get(font.id);
  if (have === "full" || have === mode) return Promise.resolve();
  const gate = `${font.id}:${mode}`;
  const pending = inflight.get(gate);
  if (pending) return pending;

  const special = isSpecialPreviewFont(font);
  const probe = isEmojiFamily(font.family) ? "😀" : scriptProbe(font.family);
  const display = special ? "block" : "swap";

  const promise = (async () => {
    const desktop = await inTauri();
    const subset = undefined;
    const hrefs =
      mode === "preview"
        ? previewFamilyParams(font).map((param) => googleCssHref(param, display, subset))
        : [
            googleCssHref(googleFamilyParam(font, mode), display),
            googleCssHref(`family=${font.family.replace(/ /g, "+")}`, display),
          ];
    if (await loadGoogleFromLocal(font, mode)) {
      if (desktop) return;
      void ensureCatalogCss(font);
      if (loadedGoogle.get(font.id) === "full" || (mode === "preview" && !font.variable)) return;
    }
    if (mode === "preview" && !special) {
      await Promise.all(hrefs.map((href) => injectGoogleCss(href, `${cssKey(font.id, mode)}:${href}`)));
      loadedGoogle.set(font.id, "preview");
      return;
    }
    if (font.variable && !special) {
      dropCssForFont(font.id);
      if (await fetchFaceAndCache(font, variableSourceUrls(font.family))) {
        loadedGoogle.set(font.id, "full");
        void ensureCatalogCss(font);
        if (font.italic) void fetchFaceAndCache(font, variableSourceUrls(font.family, true), "italic");
        return;
      }
      const vfHref = googleCssHref(googleFamilyParam(font, "full"), display);
      await injectGoogleCss(vfHref, `${cssKey(font.id, "full")}:${vfHref}`);
      await waitForFamily(font.family, probe, 1200);
      if (familyLoaded(font.family, probe)) {
        loadedGoogle.set(font.id, "full");
        return;
      }
    }
    const net = special ? specialSourceUrls(font.family) : latinSourceUrls(font.family);
    if (!font.variable && (await fetchFaceAndCache(font, net))) {
      loadedGoogle.set(font.id, special || font.variable ? "full" : mode);
      if (!special && !font.variable) {
        if (font.italic) void fetchFaceAndCache(font, latinSourceUrls(font.family, true, 400), "italic", 400);
        if (mode === "full") {
          for (const w of font.weights) {
            if (w === 400) continue;
            void fetchFaceAndCache(font, latinSourceUrls(font.family, false, w), "normal", w);
          }
        }
      }
      return;
    }
    for (const href of hrefs) {
      await injectGoogleCss(href, `${cssKey(font.id, mode)}:${href}`);
      await waitForFamily(font.family, probe, special ? 2500 : 700);
      if (familyLoaded(font.family, probe)) {
        loadedGoogle.set(font.id, mode);
        return;
      }
    }
    const fallback = await loadFaceFromUrls(
      font.family,
      special ? specialSourceUrls(font.family) : latinSourceUrls(font.family),
    );
    await waitForFamily(font.family, probe, special ? 2500 : 600);
    if (fallback || familyLoaded(font.family, probe)) {
      loadedGoogle.set(font.id, special ? "full" : mode);
      return;
    }
    if (special) {
      notifyIfUnusual(font, "preview");
      if (!previewFailNotified.has(font.id)) {
        previewFailNotified.add(font.id);
        toast.error(`${font.family} didn’t load in the preview`, {
          description: "Color/emoji fonts need Chrome-class rendering (this window). Retry after Activate, or check the network.",
          duration: 12_000,
        });
      }
      return;
    }
    if (mode === "full") loadedGoogle.set(font.id, "full");
  })().finally(() => {
    inflight.delete(gate);
  });

  inflight.set(gate, promise);
  return promise;
}

export async function loadLocalFont(font: FontRecord): Promise<void> {
  if (font.source !== "local") return;
  if (loadedLocal.has(font.id)) return;
  if (typeof document === "undefined") return;
  const pending = inflight.get(font.id);
  if (pending) return pending;

  const promise = (async () => {
    const blob = await idbGet(font.id);
    if (!blob) return;
    const buffer = await blob.arrayBuffer();
    const copy = buffer.slice(0);
    const probed = await rememberFileAxes(font, copy);
    const isVf = probed === true || (probed === null && font.variable);
    const family = font.cssFamily || font.family;
    const weight = isVf ? vfWeight(font) : String(font.weights[0] ?? 400);
    const style = font.italic && !isVf ? "italic" : "normal";
    const opts: FontFaceDescriptors = {
      weight,
      style,
      display: "swap",
      ...(isVf ? { stretch: "50% 200%" } : {}),
    };
    try {
      const face = new FontFace(family, copy, opts);
      await face.load();
      document.fonts.add(face);
      localFaces.set(font.id, { face, url: "" });
      loadedLocal.add(font.id);
      return;
    } catch {
      /* WebView2 sometimes rejects raw buffers; fall back to a blob URL. */
    }
    const url = URL.createObjectURL(new Blob([copy], { type: blob.type || "font/ttf" }));
    const face = new FontFace(family, `url(${url})`, opts);
    await face.load();
    document.fonts.add(face);
    localFaces.set(font.id, { face, url });
    loadedLocal.add(font.id);
  })()
    .catch(() => {
      if (!previewFailNotified.has(font.id)) {
        previewFailNotified.add(font.id);
        toast.error(`${font.family} didn’t load in the preview`, {
          description: "Delete it and re-upload the TTF or OTF.",
          duration: 12_000,
        });
      }
    })
    .finally(() => {
      inflight.delete(font.id);
    });

  inflight.set(font.id, promise);
  return promise;
}

export function loadFont(font: FontRecord, mode: FontLoadMode = "preview"): Promise<void> {
  return font.source === "local" ? loadLocalFont(font) : loadGoogleFont(font, mode);
}

async function loadItalicFromDisk(font: FontRecord): Promise<boolean> {
  if (!(await inTauri())) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const path = await invoke<string>("read_family_font", { family: font.family, italic: true });
    const name = path.toLowerCase();
    if (!name.includes("italic") && !name.includes("oblique")) return false;
    const bytes = await readFile(path);
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return faceFromBuffer(font.family, copy, {
      style: "italic",
      variable: font.variable,
      weight: font.variable ? vfWeight(font) : "400",
    });
  } catch {
    return false;
  }
}

export async function loadItalicFace(font: FontRecord): Promise<void> {
  if (await loadItalicFromDisk(font)) {
    if (typeof document !== "undefined" && document.fonts?.load) {
      try {
        await document.fonts.load(`italic 48px "${font.cssFamily || font.family}"`);
      } catch {
        /* ignore */
      }
    }
    return;
  }
  if (font.source === "local") {
    await loadLocalFont(font);
    return;
  }
  if (font.variable) {
    if (await fetchFaceAndCache(font, variableSourceUrls(font.family, true), "italic")) return;
  }
  if (await fetchFaceAndCache(font, latinSourceUrls(font.family, true, 400), "italic", 400)) {
    return;
  }
  const family = font.family.replace(/ /g, "+");
  await injectGoogleCss(
    googleCssHref(`family=${family}:ital,wght@1,400`, "swap"),
    `italic:${font.id}`,
  );
  if (typeof document !== "undefined" && document.fonts?.load) {
    try {
      await document.fonts.load(`italic 48px "${font.cssFamily || font.family}"`);
    } catch {
      /* ignore */
    }
  }
}

export async function loadFontWeight(font: FontRecord, weight: number, italic = false): Promise<void> {
  if (italic) void loadItalicFace(font);
  if (font.variable) {
    await loadFont(font, "full");
  } else if (font.source === "local") {
    await loadLocalFont(font);
  } else {
    await fetchFaceAndCache(
      font,
      latinSourceUrls(font.family, italic, weight),
      italic ? "italic" : "normal",
      weight,
    );
  }
  if (typeof document !== "undefined" && document.fonts?.load) {
    const family = font.cssFamily || font.family;
    try {
      await document.fonts.load(`${weight} ${italic ? "italic" : "normal"} 48px "${family}"`);
    } catch {
      /* ignore */
    }
  }
}

export async function unloadLocalFont(id: string): Promise<void> {
  const entry = localFaces.get(id);
  if (entry) {
    document.fonts.delete(entry.face);
    if (entry.url) URL.revokeObjectURL(entry.url);
    localFaces.delete(id);
  }
  loadedLocal.delete(id);
}

export function cssFamilyStack(font: FontRecord): string {
  return stackFor(font);
}

export function googleCssUrl(fonts: FontRecord[]): string {
  const urls = googleCssUrls(fonts);
  return urls[0] ?? "";
}

export function googleCssUrls(fonts: FontRecord[]): string[] {
  const google = fonts.filter((f) => f.source === "google");
  if (!google.length) return [];
  const chunks: FontRecord[][] = [];
  for (let i = 0; i < google.length; i += 18) chunks.push(google.slice(i, i + 18));
  return chunks.map((chunk) => {
    const params = chunk.map((font) => previewFamilyParams(font)[0] ?? googleFamilyParam(font, "preview")).join("&");
    return `https://fonts.googleapis.com/css2?${params}&display=swap&v=${cssStamp()}`;
  });
}

/** One or two CSS requests for the visible library page — same path on Grok and desktop. */
export function primeGooglePreview(fonts: FontRecord[]): Promise<void> {
  const google = fonts.filter((f) => f.source === "google" && !isSpecialPreviewFont(f));
  if (!google.length || typeof document === "undefined") return Promise.resolve();
  const urls = googleCssUrls(google);
  return Promise.all(
    urls.map((href, i) => injectGoogleCss(href, `prime:${i}:${href.slice(-48)}`)),
  ).then(() => {
    for (const font of google) {
      if (!loadedGoogle.has(font.id)) loadedGoogle.set(font.id, "preview");
    }
  });
}
