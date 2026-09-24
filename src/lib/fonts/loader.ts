import type { FontRecord } from "./types";
import { idbGet, idbPutPreview, previewCacheId } from "./idb";
import { isEmojiFamily } from "./emoji";
import { axesForFont, previewWghtAxis } from "./axes";
import { isSpecialPreviewFont, notifyIfUnusual } from "./color-font";
import { cssFamilyStack as stackFor, previewFaceName } from "./fallback";
import { scriptProbe, scriptSampleText, scriptSubset } from "./scripts";
import { toast } from "sonner";

async function inTauri() {
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
/** Injected Google/Fontsource `<style>` tags — CSSOM has no FontFace LRU. */
export const CSS_LRU = 96;
const cssOrder: string[] = [];
const cssPinned = new Set<string>();

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
  if (probedIds.has(font.id) && font.axes !== undefined && font.metrics) return font.axes.length > 0;
  try {
    const { nativeFamilyLayout, nativeLayoutFromBytes, fontMetricsFromLayout } = await import("./native-parse");
    const layout = (await nativeFamilyLayout(font.family)) ?? (await nativeLayoutFromBytes(buffer));
    if (layout) {
      probedIds.add(font.id);
      const { useFontStore } = await import("./store");
      const store = useFontStore.getState();
      if (layout.axes.length) {
        store.patchFontAxes(font.id, layout.axes);
        font.axes = layout.axes;
        font.variable = true;
      }
      const metrics = fontMetricsFromLayout(layout);
      if (metrics) {
        store.patchFontMetrics(font.id, metrics);
        font.metrics = metrics;
      }
      return layout.axes.length > 0;
    }
    const { axesFromBuffer } = await import("./parse-font");
    const axes = await axesFromBuffer(buffer);
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
      const { nativeFamilyLayout, fontMetricsFromLayout } = await import("./native-parse");
      const layout = await nativeFamilyLayout(font.family);
      const axes = layout?.axes?.length ? layout.axes : null;
      if (layout) {
        probedIds.add(font.id);
        const { useFontStore } = await import("./store");
        const store = useFontStore.getState();
        if (axes) {
          store.patchFontAxes(font.id, axes);
          font.axes = axes;
          font.variable = true; // real fvar from on-disk face
        }
        const metrics = fontMetricsFromLayout(layout);
        if (metrics) {
          store.patchFontMetrics(font.id, metrics);
          font.metrics = metrics;
        }
      }
      // Never treat catalog.variable alone as VF (42dot statics / Fontsource-other).
      const isVf = Boolean(axes?.length) || (font.variable && Boolean(font.axes?.length));
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

export function pinCss(key: string) {
  cssPinned.add(key);
  const at = cssOrder.indexOf(key);
  if (at >= 0) {
    cssOrder.splice(at, 1);
    cssOrder.push(key);
  }
}

export function unpinCss(key: string) {
  cssPinned.delete(key);
}

function rememberCss(key: string, el: HTMLElement) {
  googleLinks.set(key, el);
  const at = cssOrder.indexOf(key);
  if (at >= 0) cssOrder.splice(at, 1);
  cssOrder.push(key);
  while (cssOrder.length > CSS_LRU) {
    const old = cssOrder.find((k) => k !== key && !cssPinned.has(k));
    if (!old) break;
    const idx = cssOrder.indexOf(old);
    if (idx >= 0) cssOrder.splice(idx, 1);
    const node = googleLinks.get(old);
    try {
      node?.remove();
    } catch {
      /* ignore */
    }
    googleLinks.delete(old);
  }
}

function previewIsVf(font: Pick<FontRecord, "variable" | "catalogVariable">) {
  return Boolean(font.variable || font.catalogVariable);
}

function googleCssHref(param: string, display: string) {
  return `https://fonts.googleapis.com/css2?${param}&display=${display}`;
}

function previewFamilyParam(font: FontRecord, italic = false): string {
  const family = font.family.replace(/ /g, "+");
  if (isSpecialPreviewFont(font)) return `family=${family}`;
  if (previewIsVf(font)) {
    const wght = axesForFont(font).find((a) => a.tag === "wght") ?? previewWghtAxis(font);
    const min = Math.round(wght?.min ?? 100);
    const max = Math.round(wght?.max ?? 900);
    if (italic && font.italic) return `family=${family}:ital,wght@1,${min}..${max}`;
    // ital=0 (not a bare :wght@ range) so Google serves the roman VF face.
    if (font.italic) return `family=${family}:ital,wght@0,${min}..${max}`;
    return `family=${family}:wght@${min}..${max}`;
  }
  if (italic && font.italic) return `family=${family}:ital,wght@1,400`;
  if (font.italic) return `family=${family}:ital,wght@0,400`;
  return `family=${family}:wght@400`;
}

/** Library CSS2: Regular 400 + `text=` of the specimen — not the full unicode-range sheet.
 *  Noto Sans JP CSS2 without text= is 100+ faces and freezes WebView2. */
export function googlePreviewTextQuery(family: string) {
  const sample = scriptSampleText(family);
  const latin = scriptSubset(family) === "latin";
  const pangram = "The quick brown fox jumps over the lazy dog ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
  const raw = latin ? pangram : sample || pangram;
  let out = "";
  const seen = new Set<string>();
  for (const ch of raw) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    out += ch;
    if (out.length >= 80) break;
  }
  return encodeURIComponent(out || "Aa");
}

export function googlePreviewCssHref(
  font: Pick<FontRecord, "family" | "italic" | "catalogVariable" | "variable" | "weights">,
  italic = false,
) {
  const family = font.family.replace(/ /g, "+");
  const span = previewWghtAxis(font);
  const face =
    italic && font.italic
      ? span
        ? `family=${family}:ital,wght@1,${Math.round(span.min)}..${Math.round(span.max)}`
        : `family=${family}:ital,wght@1,400`
      : span
        ? `family=${family}:wght@${Math.round(span.min)}..${Math.round(span.max)}`
        : `family=${family}:wght@400`;
  return `https://fonts.googleapis.com/css2?${face}&text=${googlePreviewTextQuery(font.family)}&display=swap`;
}

/** Latin on-disk TTF/OTF for cards: convertFileSrc. Never CJK / Unifont / color. VF latin on disk is allowed. */
export function googlePreviewMayUseLocalDisk(font: FontRecord) {
  return (
    font.source === "google" &&
    !isSpecialPreviewFont(font) &&
    scriptSubset(font.family) === "latin"
  );
}

function catalogCssHrefs(font: FontRecord, mode: FontLoadMode, italic = false): string[] {
  // Hard separation: Fontsource cards = Fontsource only; Google cards = Google only.
  // Never dual Google+Fontsource hrefs on the same card (wrong face / hang risk).
  if (font.catalog === "other") return fontsourceCssHrefs(font, mode, italic);
  // Catalog VF (42dot, etc.) must use CSS2 wght range even when badge `variable` is still false.
  if (mode === "preview" && !isSpecialPreviewFont(font)) {
    return [googlePreviewCssHref(font, italic)];
  }
  const display = isSpecialPreviewFont(font) ? "block" : "swap";
  return [googleCssHref(previewFamilyParam(font, italic), display)];
}

function fontsourceCssHref(font: FontRecord, mode: FontLoadMode, italic = false): string {
  const slug = slugFamily(font.family);
  if (previewIsVf(font)) {
    const face = italic ? "wght-italic.css" : "wght.css";
    return `https://cdn.jsdelivr.net/npm/@fontsource-variable/${slug}/${face}`;
  }
  const pkg = `@fontsource/${slug}`;
  if (italic) return `https://cdn.jsdelivr.net/npm/${pkg}/latin-400-italic.css`;
  if (mode === "full") return `https://cdn.jsdelivr.net/npm/${pkg}/latin.css`;
  return `https://cdn.jsdelivr.net/npm/${pkg}/index.css`;
}

function fontsourceCssHrefs(font: FontRecord, mode: FontLoadMode, italic = false): string[] {
  const slug = slugFamily(font.family);
  const primary = fontsourceCssHref(font, mode, italic);
  if (previewIsVf(font)) {
    const alt = italic
      ? `https://cdn.jsdelivr.net/fontsource/css/${slug}:vf@latest/wght-italic.css`
      : `https://cdn.jsdelivr.net/fontsource/css/${slug}:vf@latest/wght.css`;
    return primary === alt ? [primary] : [primary, alt];
  }
  const alt = italic
    ? `https://cdn.jsdelivr.net/fontsource/css/${slug}@latest/latin-400-italic.css`
    : `https://cdn.jsdelivr.net/fontsource/css/${slug}@latest/index.css`;
  return primary === alt ? [primary] : [primary, alt];
}

function cssWithAbsoluteUrls(css: string, href: string) {
  let base: URL;
  try {
    base = new URL(href);
  } catch {
    return css;
  }
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, quote: string, raw: string) => {
    const src = raw.trim();
    if (!src || /^(data:|https?:|blob:|\/\/|#)/i.test(src)) return full;
    try {
      return `url(${quote}${new URL(src, base).href}${quote})`;
    } catch {
      return full;
    }
  });
}

function rewriteCssFamily(css: string, family: string) {
  const compact = family.replace(/\s+/g, "");
  return css.replace(/font-family\s*:\s*(['"]?)([^;'"]+?)\1(?=\s*;)/gi, (full, _q, name: string) => {
    const n = name.trim();
    if (n === family) return full;
    const compactName = n.replace(/\s+/g, "");
    if (compactName === compact || compactName === `${compact}Variable` || n === `${family} Variable`) {
      return `font-family: ${JSON.stringify(family)}`;
    }
    return full;
  });
}

function markWoff2Variations(css: string) {
  return css.replace(/@font-face\s*\{[^}]*\}/gi, (block) => {
    if (!/font-weight\s*:\s*[\d.]+\s+[\d.]+/i.test(block)) return block;
    return block.replace(/format\(\s*(['"])woff2\1\s*\)/gi, "format($1woff2-variations$1)");
  });
}

function ensureFontDisplaySwap(css: string) {
  return css.replace(/@font-face\s*\{[^}]*\}/gi, (block) => {
    if (/font-display\s*:/i.test(block)) {
      return block.replace(/font-display\s*:\s*[^;]+;?/gi, "font-display: swap;");
    }
    return block.replace(/@font-face\s*\{/i, "@font-face { font-display: swap;");
  });
}

function cssForInject(css: string, href: string, family?: string) {
  let text = cssWithAbsoluteUrls(css, href);
  // Named instances pin Regular and ignore font-weight / wght on the card slider.
  text = text.replace(/font-named-instance\s*:\s*[^;]+;?/gi, "");
  text = markWoff2Variations(text);
  text = ensureFontDisplaySwap(text);
  if (family) text = rewriteCssFamily(text, family);
  return text;
}

function injectLinkCss(href: string, key: string): Promise<void> {
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.fontKey = key;
    link.dataset.href = href;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    link.onload = done;
    link.onerror = done;
    window.setTimeout(done, 1800);
    document.head.appendChild(link);
    rememberCss(key, link);
  });
}

function injectGoogleCss(href: string, key: string, family?: string): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  const existing = googleLinks.get(key);
  if (existing?.dataset.href === href) return Promise.resolve();
  if (existing) {
    try {
      existing.remove();
    } catch {
      /* ignore */
    }
    googleLinks.delete(key);
    const at = cssOrder.indexOf(key);
    if (at >= 0) cssOrder.splice(at, 1);
  }

  // Google CSS2 is already the right family + text= subset. Fetching it from JS
  // trips CORS in the preview (console errors, blank cards). <link> uses the
  // browser cache; wait for onload so waitForFamily sees the @font-face.
  // Fontsource still needs fetch so we can rewrite family names.
  if (/fonts\.googleapis\.com/i.test(href)) {
    return injectLinkCss(href, key);
  }

  return withCssSlot(async () => {
    const cacheId = `css:vf3:${key}`;
    try {
      const { idbGet, idbPut } = await import("./idb");
      const cached = await idbGet(cacheId);
      let text = cached ? await cached.text() : "";
      if (!text) {
        const res = await fetch(href, { cache: "force-cache", signal: AbortSignal.timeout(4500) });
        if (res.ok) text = await res.text();
        if (text.length > 80 && text.length < 400_000) {
          text = cssForInject(text, href, family);
          void idbPut(cacheId, new Blob([text], { type: "text/css" }));
        }
      } else {
        text = cssForInject(text, href, family);
      }
      if (text) {
        const style = document.createElement("style");
        style.dataset.fontKey = key;
        style.dataset.href = href;
        style.textContent = cssForInject(text, href, family);
        document.head.appendChild(style);
        rememberCss(key, style);
        return;
      }
    } catch {
      /* network / idb / CORS */
    }
    injectLinkCss(href, key);
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
  } else if (/emoji/i.test(family)) {
    urls.unshift(
      `https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/emoji-400-normal.ttf`,
      `https://cdn.jsdelivr.net/npm/@fontsource/${slug}/files/${slug}-emoji-400-normal.ttf`,
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
    if (!key.startsWith(`${id}:`) && key !== `cover:${id}` && key !== `italic:${id}`) continue;
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

/** Library cards use CSS preview. VF woff2 FontFace is inspector/slider `full`. */
export function googlePreviewIsCssOnly(mode: FontLoadMode, special: boolean) {
  return mode === "preview" && !special;
}

/** Prime batch CSS: latin statics only. VF ranges + CJK/emoji in an 18-family CSS2 URL freeze WebView2. */
export function primeGooglePreviewAllows(font: FontRecord) {
  return (
    font.source === "google" &&
    !isSpecialPreviewFont(font) &&
    scriptSubset(font.family) === "latin"
  );
}

async function loadGooglePreviewFromLocal(font: FontRecord): Promise<boolean> {
  if (!googlePreviewMayUseLocalDisk(font)) return false;
  if (typeof document === "undefined") return false;
  // GDI-live families already resolve in WebView2 — do not FontFace.load the
  // same TTF (that hung Fontsource browsing at ~98 Live).
  if (familyLoaded(font.family, scriptProbe(font.family))) return true;
  if (!(await inTauri()) || !likelyOnDisk(font)) return false;
  try {
    const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");
    const path = await invoke<string>("read_family_font", { family: font.family });
    if (/unifont|cjk|emoji|noto-sans-jp|noto-serif-jp|noto-sans-kr|noto-serif-kr|noto-sans-sc|noto-serif-sc|noto-sans-tc|noto-serif-tc|chiron/i.test(path)) {
      return false;
    }
    const url = convertFileSrc(path);
    const isVf = Boolean(font.variable || font.catalogVariable);
    const face = new FontFace(font.family, `url(${JSON.stringify(url)})`, {
      display: "swap",
      style: "normal",
      weight: isVf ? vfWeight(font) : "400",
      ...(isVf ? { stretch: "50% 200%" } : {}),
    });
    await face.load();
    document.fonts.add(face);
    rememberFace(font.family, face);
    return true;
  } catch {
    return false;
  }
}

function ensureCatalogCss(font: FontRecord) {
  if (font.catalog === "other") {
    const href = fontsourceCssHrefs(font, "preview")[0];
    return href ? injectGoogleCss(href, `cover:${font.id}`, font.family) : Promise.resolve();
  }
  return injectGoogleCss(googleCssHref(previewFamilyParam(font, false), "swap"), `cover:${font.id}`, font.family);
}

export function loadGoogleFont(font: FontRecord, mode: FontLoadMode = "preview"): Promise<void> {
  if (font.source !== "google") return Promise.resolve();
  const have = loadedGoogle.get(font.id);
  if (have === "full") return Promise.resolve();
  if (have === mode && (mode !== "preview" || googleLinks.has(`cover:${font.id}`))) return Promise.resolve();
  const gate = `${font.id}:${mode}`;
  const pending = inflight.get(gate);
  if (pending) return pending;

  const special = isSpecialPreviewFont(font);
  const probe = isEmojiFamily(font.family) ? "😀" : scriptProbe(font.family);

  const promise = (async () => {
    const hrefs = catalogCssHrefs(font, mode);
    // Card preview: CSS only (static + VF range). Do not fetch VF woff2 / parse
    // axes / convertFileSrc a CJK TTF — that hangs Google Fonts scrolling.
    if (googlePreviewIsCssOnly(mode, special)) {
      if (familyLoaded(font.family, probe)) {
        loadedGoogle.set(font.id, "preview");
        return;
      }
      if (await loadGooglePreviewFromLocal(font)) {
        loadedGoogle.set(font.id, "preview");
        return;
      }
      let ok = false;
      for (const href of hrefs) {
        await injectGoogleCss(href, `cover:${font.id}`, font.family);
        await waitForFamily(font.family, probe, 900);
        if (familyLoaded(font.family, probe)) {
          ok = true;
          break;
        }
      }
      if (ok) loadedGoogle.set(font.id, "preview");
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
      const vfHref = googleCssHref(previewFamilyParam(font, false), "swap");
      await injectGoogleCss(vfHref, `${cssKey(font.id, "full")}:${vfHref}`, font.family);
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
      await injectGoogleCss(href, `${cssKey(font.id, mode)}:${href}`, font.family);
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
    if (await loadGoogleFromLocal(font, mode)) {
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
    const family = previewFaceName(font);
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
  if (font.source === "system") {
    // Already in the OS font table. Do not inject FontFace from C:\Windows\Fonts —
    // convertFileSrc often fails, and a failed face with the same family name
    // hides the real system specimen.
    return Promise.resolve();
  }
  if (font.source === "local") {
    return font.originPath ? loadPathFont(font) : loadLocalFont(font);
  }
  return loadGoogleFont(font, mode);
}

async function loadPathFont(font: FontRecord): Promise<void> {
  if (!font.originPath) return;
  if (loadedLocal.has(font.id)) return;
  if (typeof document === "undefined") return;
  const pending = inflight.get(font.id);
  if (pending) return pending;
  const promise = (async () => {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const url = convertFileSrc(font.originPath!);
    const family = previewFaceName(font);
    const isVf = font.variable;
    const face = new FontFace(family, `url(${JSON.stringify(url)})`, {
      display: isSpecialPreviewFont(font) ? "block" : "swap",
      style: font.italic && !isVf ? "italic" : "normal",
      weight: isVf ? vfWeight(font) : String(font.weights[0] ?? 400),
      ...(isVf ? { stretch: "50% 200%" } : {}),
    });
    await face.load();
    document.fonts.add(face);
    localFaces.set(font.id, { face, url: "" });
    loadedLocal.add(font.id);
  })().catch(() => {
    /* system font still types in other apps */
  });
  inflight.set(font.id, promise);
  try {
    await promise;
  } finally {
    inflight.delete(font.id);
  }
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
  await injectGoogleCss(catalogCssHrefs(font, "preview", true)[0]!, `italic:${font.id}`, font.family);
  if (typeof document !== "undefined" && document.fonts?.load) {
    try {
      await document.fonts.load(`italic 48px "${font.cssFamily || font.family}"`);
    } catch {
      /* ignore */
    }
  }
  if (await loadItalicFromDisk(font)) return;
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
    const family = previewFaceName(font);
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
  const google = fonts.filter((f) => f.source === "google" && f.catalog !== "other");
  if (!google.length) return [];
  const chunks: FontRecord[][] = [];
  for (let i = 0; i < google.length; i += 8) chunks.push(google.slice(i, i + 8));
  return chunks.map((chunk) => {
    const params = chunk.map((font) => previewFamilyParam(font, false)).join("&");
    return googleCssHref(params, "swap");
  });
}

/** Batched CSS for the visible page. Official Google → CSS2; exclusive → Fontsource. */
export function primeGooglePreview(fonts: FontRecord[]): Promise<void> {
  const google = fonts.filter(primeGooglePreviewAllows);
  if (!google.length || typeof document === "undefined") return Promise.resolve();
  return Promise.all(
    google.map((font) => {
      const href =
        font.catalog === "other"
          ? fontsourceCssHrefs(font, "preview")[0]
          : googlePreviewCssHref(font);
      return href ? injectGoogleCss(href, `cover:${font.id}`, font.family) : Promise.resolve();
    }),
  ).then(() => undefined);
}
