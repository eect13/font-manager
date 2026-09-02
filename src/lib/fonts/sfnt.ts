/** Fast SFNT / WOFF1 / TTC reader. Skips glyph outlines (opentype.js is the fallback). */

export type SfntAxis = { tag: string; name: string; min: number; max: number; def: number };
export type SfntInstance = { name: string; coords: Record<string, number> };
export type SfntFace = {
  family: string;
  subfamily: string;
  fullName: string;
  version: string;
  weight: number;
  italic: boolean;
  glyphCount: number;
  axes: SfntAxis[];
  instances: SfntInstance[];
  otFeatures: string[];
  varStorage: string;
  licenseText: string;
  /** Standalone SFNT for this face (TTC/WOFF decoded). */
  buffer: ArrayBuffer;
  faceIndex: number;
  faceCount: number;
  format: string;
};

const NAME_FAMILY = 1;
const NAME_SUBFAMILY = 2;
const NAME_FULL = 4;
const NAME_VERSION = 5;
const NAME_LICENSE = 13;
const NAME_LICENSE_URL = 14;
const NAME_TYPO_FAMILY = 16;
const NAME_TYPO_SUBFAMILY = 17;
const NAME_WWS_FAMILY = 21;

function u16(v: DataView, o: number) {
  if (o + 2 > v.byteLength) return 0;
  return v.getUint16(o, false);
}
function u32(v: DataView, o: number) {
  if (o + 4 > v.byteLength) return 0;
  return v.getUint32(o, false);
}
function tag(bytes: Uint8Array, o: number) {
  if (o + 4 > bytes.length) return "";
  return String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
}
function magicOf(bytes: Uint8Array) {
  return tag(bytes, 0);
}

type Table = { tag: string; offset: number; length: number; bytes: Uint8Array };

function tableMapFromSfnt(bytes: Uint8Array, offset = 0): Map<string, Table> {
  const out = new Map<string, Table>();
  if (offset + 12 > bytes.length) return out;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = u16(v, offset + 4);
  let p = offset + 12;
  for (let i = 0; i < n && p + 16 <= bytes.length; i += 1, p += 16) {
    const t = tag(bytes, p);
    const off = u32(v, p + 8);
    const len = u32(v, p + 12);
    if (!t || off + len > bytes.length) continue;
    out.set(t, { tag: t, offset: off, length: len, bytes });
  }
  return out;
}

function viewAt(table: Table) {
  return new DataView(table.bytes.buffer, table.bytes.byteOffset + table.offset, table.length);
}
function sliceTable(table: Table) {
  return table.bytes.subarray(table.offset, table.offset + table.length);
}

function buildSfnt(flavor: string, tables: { tag: string; data: Uint8Array }[]): ArrayBuffer {
  const n = tables.length;
  let search = 1;
  let exp = 0;
  while (search * 2 <= n) {
    search *= 2;
    exp += 1;
  }
  const searchRange = search * 16;
  const rangeShift = n * 16 - searchRange;
  let offset = 12 + 16 * n;
  const dir: number[] = [];
  const bodyParts: Uint8Array[] = [];
  for (const table of tables) {
    const raw = table.data;
    const padded = (raw.length + 3) & ~3;
    const tagCodes = [0, 1, 2, 3].map((i) => table.tag.charCodeAt(i) || 32);
    dir.push(...tagCodes, 0, 0, 0, 0);
    dir.push((offset >>> 24) & 255, (offset >>> 16) & 255, (offset >>> 8) & 255, offset & 255);
    dir.push((raw.length >>> 24) & 255, (raw.length >>> 16) & 255, (raw.length >>> 8) & 255, raw.length & 255);
    const pad = new Uint8Array(padded);
    pad.set(raw);
    bodyParts.push(pad);
    offset += padded;
  }
  const header = new Uint8Array(12 + dir.length);
  const flavorBytes = [0, 1, 2, 3].map((i) => flavor.charCodeAt(i) || 0);
  if (flavor === "\x00\x01\x00\x00") {
    header.set([0, 1, 0, 0], 0);
  } else {
    header.set(flavorBytes, 0);
  }
  header[4] = (n >>> 8) & 255;
  header[5] = n & 255;
  header[6] = (searchRange >>> 8) & 255;
  header[7] = searchRange & 255;
  header[8] = (exp >>> 8) & 255;
  header[9] = exp & 255;
  header[10] = (rangeShift >>> 8) & 255;
  header[11] = rangeShift & 255;
  header.set(dir, 12);
  const total = header.length + bodyParts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  out.set(header, 0);
  let o = header.length;
  for (const part of bodyParts) {
    out.set(part, o);
    o += part.length;
  }
  return out.buffer;
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") throw new Error("no inflate");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeWoff1(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 44) throw new Error("woff header");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flavor = tag(bytes, 4);
  const numTables = u16(v, 12);
  const tables: { tag: string; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const o = 44 + i * 20;
    const t = tag(bytes, o);
    const offset = u32(v, o + 4);
    const compLen = u32(v, o + 8);
    const origLen = u32(v, o + 12);
    if (offset + compLen > bytes.length) continue;
    const slice = bytes.subarray(offset, offset + compLen);
    let raw: Uint8Array;
    if (compLen >= origLen) {
      raw = slice.subarray(0, origLen);
    } else {
      try {
        raw = await inflateZlib(slice);
        if (raw.length > origLen) raw = raw.subarray(0, origLen);
      } catch {
        continue;
      }
    }
    tables.push({ tag: t, data: raw });
  }
  return new Uint8Array(buildSfnt(flavor || "\x00\x01\x00\x00", tables));
}

function decodeUtf16Be(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = (bytes[i]! << 8) | bytes[i + 1]!;
    if (c) s += String.fromCharCode(c);
  }
  return s.trim();
}

function decodeMacRoman(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s.trim();
}

function readName(tables: Map<string, Table>): Record<number, string> {
  const table = tables.get("name");
  if (!table) return {};
  const bytes = sliceTable(table);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = u16(v, 2);
  const stringOff = u16(v, 4);
  type Hit = { score: number; text: string };
  const best = new Map<number, Hit>();
  for (let i = 0; i < count; i += 1) {
    const rec = 6 + i * 12;
    if (rec + 12 > bytes.length) break;
    const platform = u16(v, rec);
    const encoding = u16(v, rec + 2);
    const lang = u16(v, rec + 4);
    const id = u16(v, rec + 6);
    const len = u16(v, rec + 8);
    const off = u16(v, rec + 10);
    const start = stringOff + off;
    if (start + len > bytes.length) continue;
    const raw = bytes.subarray(start, start + len);
    let text = "";
    let score = 0;
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      text = decodeUtf16Be(raw);
      score = lang === 0x0409 ? 5 : 4;
    } else if (platform === 0) {
      text = decodeUtf16Be(raw);
      score = 3;
    } else if (platform === 1) {
      text = decodeMacRoman(raw);
      score = 1;
    }
    if (!text) continue;
    const prev = best.get(id);
    if (!prev || score > prev.score) best.set(id, { score, text });
  }
  const out: Record<number, string> = {};
  for (const [id, hit] of best) out[id] = hit.text;
  return out;
}

function readOs2(tables: Map<string, Table>): { weight: number; italic: boolean } {
  const table = tables.get("OS/2");
  if (!table || table.length < 64) return { weight: 400, italic: false };
  const v = viewAt(table);
  const weight = u16(v, 4);
  const fsSelection = u16(v, 62);
  return {
    weight: weight >= 100 && weight <= 1000 ? weight : 400,
    italic: Boolean(fsSelection & 0x01),
  };
}

function readMaxp(tables: Map<string, Table>): number {
  const table = tables.get("maxp");
  if (!table || table.length < 6) return 0;
  return u16(viewAt(table), 4);
}

function fixed16(v: DataView, o: number) {
  return v.getInt32(o, false) / 65536;
}

function readFvar(tables: Map<string, Table>, names: Record<number, string>): {
  axes: SfntAxis[];
  instances: SfntInstance[];
} {
  const table = tables.get("fvar");
  if (!table || table.length < 16) return { axes: [], instances: [] };
  const bytes = sliceTable(table);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const axisOff = u16(v, 4);
  const axisCount = u16(v, 8);
  const axisSize = u16(v, 10) || 20;
  const instCount = u16(v, 12);
  const instSize = u16(v, 14);
  const axes: SfntAxis[] = [];
  for (let i = 0; i < axisCount; i += 1) {
    const o = axisOff + i * axisSize;
    if (o + 20 > bytes.length) break;
    const t = tag(bytes, o);
    const min = fixed16(v, o + 4);
    const def = fixed16(v, o + 8);
    const max = fixed16(v, o + 12);
    const nameId = u16(v, o + 18);
    if (!t || !(max > min) && t !== "ital") continue;
    axes.push({ tag: t, name: names[nameId] || t, min, max, def });
  }
  const instances: SfntInstance[] = [];
  const instOff = axisOff + axisCount * axisSize;
  for (let i = 0; i < instCount; i += 1) {
    const o = instOff + i * (instSize || 4 + 4 + 4 * axisCount);
    if (o + 4 > bytes.length) break;
    const nameId = u16(v, o);
    const coords: Record<string, number> = {};
    let p = o + 4;
    if (instSize >= 8 + 4 * axisCount) p = o + 8;
    for (let a = 0; a < axes.length; a += 1) {
      if (p + 4 > bytes.length) break;
      coords[axes[a]!.tag] = fixed16(v, p);
      p += 4;
    }
    const name = names[nameId];
    if (name && Object.keys(coords).length) instances.push({ name, coords });
  }
  return { axes, instances };
}

function readFeatureTags(tables: Map<string, Table>, tableTag: string): string[] {
  const table = tables.get(tableTag);
  if (!table || table.length < 10) return [];
  const bytes = sliceTable(table);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = u16(v, 0);
  const featureListOff = major === 1 && table.length >= 12 && u16(v, 2) === 0 ? u16(v, 6) : u16(v, 6);
  if (!featureListOff || featureListOff + 2 > bytes.length) return [];
  const count = u16(v, featureListOff);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    const o = featureListOff + 2 + i * 6;
    if (o + 4 > bytes.length) break;
    const t = tag(bytes, o);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function variationNote(tables: Map<string, Table>, format: string, axes: SfntAxis[]): string {
  const extras: string[] = [];
  if (format === "WOFF2") extras.push("WOFF2");
  if (format === "WOFF") extras.push("WOFF");
  if (tables.has("avar")) extras.push("avar");
  if (tables.has("HVAR") || tables.has("hvar")) extras.push("HVAR");
  if (tables.has("STAT")) extras.push("STAT");
  let storage = "none";
  if (tables.has("CFF2")) storage = "CFF2";
  else if (tables.has("gvar")) storage = "gvar";
  else if (axes.length) storage = "fvar";
  if (storage === "none" && !extras.length) return "";
  return extras.length ? `${storage} · ${extras.join(" · ")}` : storage;
}

function flavorBytes(bytes: Uint8Array, offset = 0) {
  return tag(bytes, offset) || "\x00\x01\x00\x00";
}

function extractFace(bytes: Uint8Array, offset: number): ArrayBuffer {
  const tables = tableMapFromSfnt(bytes, offset);
  const flavor = flavorBytes(bytes, offset);
  const list = [...tables.values()].map((t) => ({ tag: t.tag, data: sliceTable(t) }));
  return buildSfnt(flavor, list);
}

function parseFaceFromTables(
  tables: Map<string, Table>,
  buffer: ArrayBuffer,
  fallbackName: string,
  faceIndex: number,
  faceCount: number,
  format: string,
): SfntFace {
  const names = readName(tables);
  const os2 = readOs2(tables);
  const { axes, instances } = readFvar(tables, names);
  const ot = Array.from(
    new Set([...readFeatureTags(tables, "GSUB"), ...readFeatureTags(tables, "GPOS")]),
  ).sort();
  const family =
    names[NAME_TYPO_FAMILY] || names[NAME_WWS_FAMILY] || names[NAME_FAMILY] || fallbackName;
  const subfamily = names[NAME_TYPO_SUBFAMILY] || names[NAME_SUBFAMILY] || "";
  const italic = os2.italic || /italic|oblique/i.test(subfamily);
  const fullName = names[NAME_FULL] || [family, subfamily].filter(Boolean).join(" ") || family;
  return {
    family,
    subfamily,
    fullName,
    version: names[NAME_VERSION] || "",
    weight: os2.weight,
    italic,
    glyphCount: readMaxp(tables),
    axes,
    instances,
    otFeatures: ot,
    varStorage: variationNote(tables, format, axes),
    licenseText: [names[NAME_LICENSE], names[NAME_LICENSE_URL]].filter(Boolean).join("\n"),
    buffer,
    faceIndex,
    faceCount,
    format,
  };
}

function ttcOffsets(bytes: Uint8Array): number[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = u32(v, 8);
  const out: number[] = [];
  for (let i = 0; i < n && i < 64; i += 1) {
    const off = u32(v, 12 + i * 4);
    if (off + 12 < bytes.length) out.push(off);
  }
  return out;
}

function fallbackNameFromFile(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
}

export function sniffFontFormat(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const m = magicOf(bytes);
  if (m === "wOF2") return "WOFF2";
  if (m === "wOFF") return "WOFF";
  if (m === "ttcf") return "TTC";
  if (m === "OTTO") return "OTF";
  if (m === "true" || m === "typ1") return "TTF";
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) {
    return "TTF";
  }
  return "";
}

export async function parseSfntCollection(buffer: ArrayBuffer, fileName: string): Promise<SfntFace[]> {
  const original = new Uint8Array(buffer);
  const format = sniffFontFormat(original);
  if (!format) return [];
  const fallback = fallbackNameFromFile(fileName);

  if (format === "WOFF2") {
    return [
      {
        family: fallback,
        subfamily: "",
        fullName: fallback,
        version: "",
        weight: 400,
        italic: /italic|oblique/i.test(fileName),
        glyphCount: 0,
        axes: [],
        instances: [],
        otFeatures: [],
        varStorage: "WOFF2",
        licenseText: "",
        buffer,
        faceIndex: 0,
        faceCount: 1,
        format,
      },
    ];
  }

  let sfnt: Uint8Array = original;
  if (format === "WOFF") {
    try {
      sfnt = new Uint8Array(await decodeWoff1(original));
    } catch {
      return [];
    }
  }

  if (magicOf(sfnt) === "ttcf" || format === "TTC") {
    const offsets = ttcOffsets(sfnt);
    if (!offsets.length) return [];
    return offsets.map((off, i) => {
      const faceBuf = extractFace(sfnt, off);
      const tables = tableMapFromSfnt(new Uint8Array(faceBuf), 0);
      return parseFaceFromTables(tables, faceBuf, fallback, i, offsets.length, "TTC");
    });
  }

  const tables = tableMapFromSfnt(sfnt, 0);
  if (!tables.size) return [];
  const copy = new Uint8Array(sfnt.byteLength);
  copy.set(sfnt);
  return [parseFaceFromTables(tables, copy.buffer, fallback, 0, 1, format)];
}
