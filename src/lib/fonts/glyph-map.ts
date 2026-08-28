import { idbGet } from "./idb";
import { inDesktopShell } from "@/lib/desktop/open-fonts";
import type { FontRecord } from "./types";

export type GlyphEntry = {
  cp: number;
  char: string;
  name: string;
  gid: number;
};

export type GlyphBlock = {
  label: string;
  start: number;
  end: number;
  glyphs: GlyphEntry[];
};

export type GlyphAtlas = {
  glyphs: GlyphEntry[];
  byFont: GlyphEntry[];
  blocks: GlyphBlock[];
  fromFile: boolean;
  faceName: string;
};

const BLOCKS: { label: string; start: number; end: number }[] = [
  { label: "Basic Latin", start: 0x0020, end: 0x007f },
  { label: "Latin-1 Supplement", start: 0x00a0, end: 0x00ff },
  { label: "Latin Extended-A", start: 0x0100, end: 0x017f },
  { label: "Latin Extended-B", start: 0x0180, end: 0x024f },
  { label: "IPA Extensions", start: 0x0250, end: 0x02af },
  { label: "Spacing Modifiers", start: 0x02b0, end: 0x02ff },
  { label: "Combining Marks", start: 0x0300, end: 0x036f },
  { label: "Greek and Coptic", start: 0x0370, end: 0x03ff },
  { label: "Cyrillic", start: 0x0400, end: 0x04ff },
  { label: "Cyrillic Supplement", start: 0x0500, end: 0x052f },
  { label: "Armenian", start: 0x0530, end: 0x058f },
  { label: "Hebrew", start: 0x0590, end: 0x05ff },
  { label: "Arabic", start: 0x0600, end: 0x06ff },
  { label: "Devanagari", start: 0x0900, end: 0x097f },
  { label: "Thai", start: 0x0e00, end: 0x0e7f },
  { label: "Georgian", start: 0x10a0, end: 0x10ff },
  { label: "Hangul Jamo", start: 0x1100, end: 0x11ff },
  { label: "Latin Extended Additional", start: 0x1e00, end: 0x1eff },
  { label: "Greek Extended", start: 0x1f00, end: 0x1fff },
  { label: "General Punctuation", start: 0x2000, end: 0x206f },
  { label: "Superscripts", start: 0x2070, end: 0x209f },
  { label: "Currency", start: 0x20a0, end: 0x20cf },
  { label: "Letterlike Symbols", start: 0x2100, end: 0x214f },
  { label: "Number Forms", start: 0x2150, end: 0x218f },
  { label: "Arrows", start: 0x2190, end: 0x21ff },
  { label: "Math Operators", start: 0x2200, end: 0x22ff },
  { label: "Misc Technical", start: 0x2300, end: 0x23ff },
  { label: "Box Drawing", start: 0x2500, end: 0x257f },
  { label: "Block Elements", start: 0x2580, end: 0x259f },
  { label: "Geometric Shapes", start: 0x25a0, end: 0x25ff },
  { label: "Misc Symbols", start: 0x2600, end: 0x26ff },
  { label: "Dingbats", start: 0x2700, end: 0x27bf },
  { label: "Supplemental Arrows", start: 0x27f0, end: 0x27ff },
  { label: "Braille", start: 0x2800, end: 0x28ff },
  { label: "Supplemental Math", start: 0x2a00, end: 0x2aff },
  { label: "CJK Radicals", start: 0x2e80, end: 0x2eff },
  { label: "CJK Symbols", start: 0x3000, end: 0x303f },
  { label: "Hiragana", start: 0x3040, end: 0x309f },
  { label: "Katakana", start: 0x30a0, end: 0x30ff },
  { label: "CJK Unified Ideographs", start: 0x4e00, end: 0x9fff },
  { label: "Hangul Syllables", start: 0xac00, end: 0xd7af },
  { label: "Private Use", start: 0xe000, end: 0xf8ff },
  { label: "CJK Compatibility Ideographs", start: 0xf900, end: 0xfaff },
  { label: "Alphabetic Presentation", start: 0xfb00, end: 0xfb4f },
  { label: "Arabic Presentation-A", start: 0xfb50, end: 0xfdff },
  { label: "Arabic Presentation-B", start: 0xfe70, end: 0xfeff },
  { label: "Halfwidth / Fullwidth", start: 0xff00, end: 0xffef },
  { label: "Specials", start: 0xfff0, end: 0xffff },
  { label: "Mahjong Tiles", start: 0x1f000, end: 0x1f02f },
  { label: "Domino Tiles", start: 0x1f030, end: 0x1f09f },
  { label: "Playing Cards", start: 0x1f0a0, end: 0x1f0ff },
  { label: "Enclosed Alphanumeric Supplement", start: 0x1f100, end: 0x1f1ff },
  { label: "Enclosed Ideographic Supplement", start: 0x1f200, end: 0x1f2ff },
  { label: "Misc Symbols and Pictographs", start: 0x1f300, end: 0x1f5ff },
  { label: "Emoticons", start: 0x1f600, end: 0x1f64f },
  { label: "Ornamental Dingbats", start: 0x1f650, end: 0x1f67f },
  { label: "Transport and Map", start: 0x1f680, end: 0x1f6ff },
  { label: "Alchemical Symbols", start: 0x1f700, end: 0x1f77f },
  { label: "Geometric Shapes Extended", start: 0x1f780, end: 0x1f7ff },
  { label: "Supplemental Arrows-C", start: 0x1f800, end: 0x1f8ff },
  { label: "Supplemental Symbols and Pictographs", start: 0x1f900, end: 0x1f9ff },
  { label: "Chess Symbols", start: 0x1fa00, end: 0x1fa6f },
  { label: "Symbols and Pictographs Extended-A", start: 0x1fa70, end: 0x1faff },
  { label: "Symbols for Legacy Computing", start: 0x1fb00, end: 0x1fbff },
];

const ASCII_NAMES: Record<number, string> = {
  0x20: "SPACE",
  0x21: "EXCLAMATION MARK",
  0x22: "QUOTATION MARK",
  0x23: "NUMBER SIGN",
  0x24: "DOLLAR SIGN",
  0x25: "PERCENT SIGN",
  0x26: "AMPERSAND",
  0x27: "APOSTROPHE",
  0x28: "LEFT PARENTHESIS",
  0x29: "RIGHT PARENTHESIS",
  0x2a: "ASTERISK",
  0x2b: "PLUS SIGN",
  0x2c: "COMMA",
  0x2d: "HYPHEN-MINUS",
  0x2e: "FULL STOP",
  0x2f: "SOLIDUS",
  0x30: "DIGIT ZERO",
  0x3a: "COLON",
  0x3b: "SEMICOLON",
  0x3c: "LESS-THAN SIGN",
  0x3d: "EQUALS SIGN",
  0x3e: "GREATER-THAN SIGN",
  0x3f: "QUESTION MARK",
  0x40: "COMMERCIAL AT",
  0x5b: "LEFT SQUARE BRACKET",
  0x5c: "REVERSE SOLIDUS",
  0x5d: "RIGHT SQUARE BRACKET",
  0x5e: "CIRCUMFLEX ACCENT",
  0x5f: "LOW LINE",
  0x60: "GRAVE ACCENT",
  0x7b: "LEFT CURLY BRACKET",
  0x7c: "VERTICAL LINE",
  0x7d: "RIGHT CURLY BRACKET",
  0x7e: "TILDE",
};

export function unicodeHex(cp: number) {
  const hex = cp.toString(16).toUpperCase();
  return `U+${hex.padStart(hex.length > 4 ? hex.length : 4, "0")}`;
}

export function sortGlyphs(glyphs: GlyphEntry[]): GlyphEntry[] {
  return [...glyphs].sort((a, b) => a.cp - b.cp || a.gid - b.gid);
}

export function sortGlyphsByFont(glyphs: GlyphEntry[]): GlyphEntry[] {
  return [...glyphs].sort((a, b) => a.gid - b.gid || a.cp - b.cp);
}

export function glyphDisplay(entry: GlyphEntry) {
  if (entry.cp >= 0x0300 && entry.cp <= 0x036f) return `\u25CC${entry.char}`;
  return entry.char;
}

export function glyphLabel(entry: GlyphEntry) {
  if (ASCII_NAMES[entry.cp]) return ASCII_NAMES[entry.cp];
  if (entry.cp >= 0x41 && entry.cp <= 0x5a) return `LATIN CAPITAL LETTER ${entry.char}`;
  if (entry.cp >= 0x61 && entry.cp <= 0x7a) return `LATIN SMALL LETTER ${entry.char.toUpperCase()}`;
  if (entry.cp >= 0x30 && entry.cp <= 0x39) return `DIGIT ${entry.char}`;
  const n = entry.name.replace(/^uni([0-9A-Fa-f]+)$/i, (_, h) => `UNI${String(h).toUpperCase()}`);
  if (n && n !== ".notdef" && n !== "uni" + entry.cp.toString(16)) return n.replace(/_/g, " ");
  return unicodeHex(entry.cp);
}

function blockLabel(cp: number) {
  let lo = 0;
  let hi = BLOCKS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = BLOCKS[mid]!;
    if (cp < b.start) hi = mid - 1;
    else if (cp > b.end) lo = mid + 1;
    else return b;
  }
  const start = Math.floor(cp / 0x100) * 0x100;
  return { label: `${unicodeHex(start)}–${unicodeHex(start + 0xff)}`, start, end: start + 0xff };
}

function sanitizeFamily(name: string) {
  const t = Array.from(name)
    .map((c) => (/[a-zA-Z0-9 \-_.]/.test(c) ? c : "-"))
    .join("")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
  return t || "font";
}

function slugFamily(family: string) {
  return family
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function parseOpenType(buffer: ArrayBuffer) {
  const mod = (await import("opentype.js")) as unknown as {
    parse?: (buffer: ArrayBuffer) => {
      glyphs: {
        length: number;
        get: (i: number) => { index: number; name: string | null; unicode?: number; unicodes: number[] };
      };
    };
    default?: {
      parse: (buffer: ArrayBuffer) => {
        glyphs: {
          length: number;
          get: (i: number) => { index: number; name: string | null; unicode?: number; unicodes: number[] };
        };
      };
    };
  };
  const parse = mod.parse ?? mod.default?.parse;
  if (!parse) throw new Error("opentype parse unavailable");
  return parse(buffer);
}

function entriesFromOpenType(ot: {
  glyphs: {
    length: number;
    get: (i: number) => { index: number; name: string | null; unicode?: number; unicodes: number[] };
  };
}): GlyphEntry[] {
  const seen = new Set<number>();
  const entries: GlyphEntry[] = [];
  for (let i = 0; i < ot.glyphs.length; i += 1) {
    const g = ot.glyphs.get(i);
    const codes = g.unicodes?.length ? g.unicodes : g.unicode != null ? [g.unicode] : [];
    for (const cp of codes) {
      if (!cp || cp < 0x20 || seen.has(cp)) continue;
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      seen.add(cp);
      entries.push({
        cp,
        char: String.fromCodePoint(cp),
        name: g.name || "",
        gid: g.index,
      });
    }
  }
  return sortGlyphs(entries);
}

async function fetchBytes(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return buf.byteLength > 1000 ? buf : null;
  } catch {
    return null;
  }
}

async function bufferFromGoogleCdn(family: string): Promise<ArrayBuffer | null> {
  const slug = slugFamily(family);
  if (!slug) return null;
  const urls = [
    `https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/latin-400-normal.ttf`,
    `https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/emoji-400-normal.ttf`,
    `https://cdn.jsdelivr.net/npm/@fontsource/${slug}/files/${slug}-latin-400-normal.ttf`,
    `https://cdn.jsdelivr.net/npm/@fontsource/${slug}/files/${slug}-emoji-400-normal.ttf`,
    `https://unpkg.com/@fontsource/${slug}/files/${slug}-latin-400-normal.woff`,
    `https://cdn.jsdelivr.net/npm/@fontsource/${slug}/files/${slug}-latin-400-normal.woff`,
  ];
  if (slug === "noto-color-emoji") {
    urls.unshift(
      "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf",
      "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/Noto-COLRv1.ttf",
    );
  }
  for (const url of urls) {
    const buf = await fetchBytes(url);
    if (buf) return buf;
  }
  return null;
}

async function bufferFromDisk(family: string): Promise<ArrayBuffer | null> {
  if (await inDesktopShell()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const path = await invoke<string>("read_family_font", { family });
      if (path) {
        const data = await readFile(path);
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        if (copy.byteLength >= 1000) return copy.buffer;
      }
    } catch {
      /* try plugin-fs relative */
    }
    try {
      const { readDir, readFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
      const folder = sanitizeFamily(family);
      const rels = [
        `Font Manager/${folder}`,
        `Font Manager/Activated/${folder}`,
        `Font Manager/Library/${folder}`,
      ];
      for (const rel of rels) {
        const entries = await readDir(rel, { baseDir: BaseDirectory.Document }).catch(() => []);
        const file = entries.find((e) => /\.(ttf|otf|ttc|woff2?)$/i.test(e.name ?? ""));
        if (!file?.name) continue;
        const data = await readFile(`${rel}/${file.name}`, { baseDir: BaseDirectory.Document });
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        return copy.buffer;
      }
    } catch {
      /* continue */
    }
  }
  return null;
}

async function bufferForFont(font: FontRecord): Promise<ArrayBuffer | null> {
  if (font.source === "local") {
    const blob = await idbGet(font.id);
    if (blob) return blob.arrayBuffer();
  }
  const disk = await bufferFromDisk(font.family);
  if (disk) return disk;
  if (font.source === "google") return bufferFromGoogleCdn(font.family);
  return null;
}

const SCAN_BLOCKS = BLOCKS.filter((b) => b.end - b.start <= 1024);

async function entriesFromRenderedFace(family: string): Promise<GlyphEntry[]> {
  if (typeof document === "undefined") return [];
  try {
    await document.fonts.load(`36px "${family}"`);
  } catch {
    /* still probe */
  }
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 48;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  const g = ctx;
  g.textAlign = "center";
  g.textBaseline = "middle";

  function sample(ch: string) {
    g.clearRect(0, 0, 48, 48);
    g.fillStyle = "#000";
    g.font = `32px "${family.replace(/["\\]/g, "")}"`;
    g.fillText(ch, 24, 26);
    return g.getImageData(0, 0, 48, 48).data;
  }
  function inked(data: Uint8ClampedArray) {
    for (let i = 3; i < data.length; i += 4) if (data[i] > 10) return true;
    return false;
  }
  function same(a: Uint8ClampedArray, b: Uint8ClampedArray) {
    let diff = 0;
    for (let i = 3; i < a.length; i += 4) diff += Math.abs(a[i] - b[i]);
    return diff < 80;
  }

  const missing = sample("\uFFFE");
  const entries: GlyphEntry[] = [];
  let gid = 1;
  let n = 0;
  for (const block of SCAN_BLOCKS) {
    for (let cp = block.start; cp <= block.end; cp += 1) {
      if (cp < 0x20) continue;
      n += 1;
      if (n % 96 === 0) await new Promise<void>((r) => setTimeout(r, 0));
      const combining = cp >= 0x0300 && cp <= 0x036f;
      const ch = String.fromCodePoint(cp);
      const data = sample(ch);
      const drawn = inked(data);
      const advance = g.measureText(ch).width;
      if (!combining && !drawn && advance < 0.5) continue;
      if (!combining && drawn && same(data, missing)) continue;
      entries.push({ cp, char: ch, name: "", gid });
      gid += 1;
    }
  }
  return sortGlyphs(entries);
}

async function entriesFromBuffer(buffer: ArrayBuffer, family: string): Promise<GlyphEntry[]> {
  try {
    return entriesFromOpenType(await parseOpenType(buffer));
  } catch {
    /* woff2 / ttc */
  }
  try {
    const faceName = `fm-cmap-${slugFamily(family) || "face"}`;
    const face = new FontFace(faceName, buffer);
    await face.load();
    document.fonts.add(face);
    const mapped = await entriesFromRenderedFace(faceName);
    document.fonts.delete(face);
    return mapped;
  } catch {
    return [];
  }
}

function atlasFromEntries(entries: GlyphEntry[], fromFile: boolean, family?: string, faceName?: string): GlyphAtlas {
  const sorted = sortGlyphs(entries);
  const byBlock = new Map<string, GlyphBlock>();
  for (const glyph of sorted) {
    const meta = blockLabel(glyph.cp);
    const key = `${meta.start}-${meta.end}`;
    const block = byBlock.get(key) ?? { label: meta.label, start: meta.start, end: meta.end, glyphs: [] };
    block.glyphs.push(glyph);
    byBlock.set(key, block);
  }
  const emojiFont = /emoji|pictograph/i.test(family ?? "");
  const blocks = [...byBlock.values()].sort((a, b) => {
    if (emojiFont) {
      const ae = a.start >= 0x1f300 && a.start <= 0x1fbff ? 0 : 1;
      const be = b.start >= 0x1f300 && b.start <= 0x1fbff ? 0 : 1;
      if (ae !== be) return ae - be;
    }
    return a.start - b.start || a.end - b.end;
  });
  return { glyphs: sorted, byFont: sortGlyphsByFont(entries), blocks, fromFile, faceName: faceName || family || "" };
}

const cache = new Map<string, GlyphAtlas>();
const inflight = new Map<string, Promise<GlyphAtlas>>();
const atlasOrder: string[] = [];
const ATLAS_LRU = 48;

function rememberAtlas(id: string, atlas: GlyphAtlas) {
  cache.set(id, atlas);
  const at = atlasOrder.indexOf(id);
  if (at >= 0) atlasOrder.splice(at, 1);
  atlasOrder.push(id);
  while (atlasOrder.length > ATLAS_LRU) {
    const old = atlasOrder.shift();
    if (old && old !== id) cache.delete(old);
  }
}

export function peekGlyphAtlas(id: string) {
  const hit = cache.get(id) ?? null;
  if (hit) {
    const at = atlasOrder.indexOf(id);
    if (at >= 0) atlasOrder.splice(at, 1);
    atlasOrder.push(id);
  }
  return hit;
}

async function registerGlyphFace(font: FontRecord, buffer: ArrayBuffer | null): Promise<string> {
  const fallback = font.cssFamily || font.family;
  if (!buffer || typeof document === "undefined") return fallback;
  const name = `fm-glyphs-${font.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "face"}`;
  try {
    const face = new FontFace(name, buffer.slice(0), { display: "block" });
    await face.load();
    document.fonts.add(face);
    return name;
  } catch {
    return fallback;
  }
}

async function buildGlyphAtlas(font: FontRecord): Promise<GlyphAtlas> {
  const hit = cache.get(font.id);
  if (hit) return hit;

  let entries: GlyphEntry[] = [];
  let fromFile = false;
  let buffer: ArrayBuffer | null = null;

  try {
    const { nativeFamilyCmap, nativeCmapFromBytes } = await import("./native-parse");
    let rows = await nativeFamilyCmap(font.family);
    if (!rows && font.source === "local") {
      const blob = await idbGet(font.id);
      if (blob) {
        const buf = await blob.arrayBuffer();
        if (buf.byteLength <= 2_000_000) rows = await nativeCmapFromBytes(buf);
      }
    }
    if (rows) {
      entries = rows
        .filter((r) => r.cp >= 0x20 && (r.cp < 0xd800 || r.cp > 0xdfff))
        .map((r) => ({
          cp: r.cp,
          gid: r.gid,
          name: r.name || "",
          char: String.fromCodePoint(r.cp),
        }));
      fromFile = true;
    }
  } catch {
    /* JS fallback */
  }

  if (!fromFile && !entries.length) {
    buffer = await bufferForFont(font);
    if (buffer) {
      entries = await entriesFromBuffer(buffer, font.family);
      fromFile = entries.length > 0;
    }
  }
  if (!fromFile && !entries.length) {
    entries = await entriesFromRenderedFace(font.cssFamily || font.family);
  }
  const faceName = font.cssFamily || font.family;
  void registerGlyphFace(font, buffer);
  const atlas = atlasFromEntries(entries, fromFile, font.family, faceName);
  if (atlas.glyphs.length) rememberAtlas(font.id, atlas);
  return atlas;
}

export function loadGlyphAtlas(font: FontRecord): Promise<GlyphAtlas> {
  const hit = cache.get(font.id);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(font.id);
  if (pending) return pending;
  const work = buildGlyphAtlas(font).finally(() => {
    inflight.delete(font.id);
  });
  inflight.set(font.id, work);
  return work;
}

export function filterGlyphs(
  glyphs: GlyphEntry[],
  query: string,
  order: "unicode" | "font" = "unicode",
): GlyphEntry[] {
  const q = query.trim();
  if (!q) return glyphs;
  const lower = q.toLowerCase();
  const hex = q.replace(/^u\+/i, "");
  const asCp = /^[0-9a-f]+$/i.test(hex) && hex.length <= 6 ? Number.parseInt(hex, 16) : Number.NaN;
  const list = glyphs.filter((g) => {
        if (g.char === q || (q.length === 1 && g.char.includes(q))) return true;
        if (Number.isFinite(asCp) && g.cp === asCp) return true;
        if (g.name && g.name.toLowerCase().includes(lower)) return true;
        if (q.length >= 2 && unicodeHex(g.cp).toLowerCase().includes(lower)) return true;
        const ascii = ASCII_NAMES[g.cp];
        if (ascii && ascii.toLowerCase().includes(lower)) return true;
        return false;
      });
  return order === "font" ? sortGlyphsByFont(list) : sortGlyphs(list);
}
