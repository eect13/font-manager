import { classifyLicenseText } from "./license";
import { inferLocalStyle } from "./style-tags";
import { detectColorTables, primaryColorKind, type ColorKind } from "./color-font";
import type { FontCategory, FontLicense } from "./types";
import type { FontAxis } from "./axes";
import { tagsFromLayoutTables } from "./ot-features";
import { parseSfntCollection, sniffFontFormat, type SfntFace } from "./sfnt";
import { sha256Hex } from "./hash";

export interface ParsedLocalFont {
  family: string;
  weight: number;
  italic: boolean;
  version: string;
  glyphCount: number;
  checksum: string;
  fileName: string;
  fileSize: number;
  buffer: ArrayBuffer;
  license: FontLicense;
  licenseName: string;
  kerningKey: string;
  category: FontCategory;
  tags: string[];
  colorKind: ColorKind;
  axes: FontAxis[];
  variable: boolean;
  otFeatures: string[];
  instances: { name: string; coords: Record<string, number> }[];
  varStorage: string;
}

function guessWeight(subfamily: string, usWeight?: number): number {
  if (usWeight && usWeight >= 100 && usWeight <= 900) return usWeight;
  const s = subfamily.toLowerCase();
  if (s.includes("thin")) return 100;
  if (s.includes("extralight") || s.includes("ultralight")) return 200;
  if (s.includes("light")) return 300;
  if (s.includes("medium")) return 500;
  if (s.includes("semibold") || s.includes("demibold")) return 600;
  if (s.includes("extrabold") || s.includes("ultrabold")) return 800;
  if (s.includes("black") || s.includes("heavy")) return 900;
  if (s.includes("bold")) return 700;
  return 400;
}

type OpenTypeFont = {
  names: unknown;
  tables: {
    os2?: { usWeightClass?: number; fsSelection?: number };
    [key: string]: unknown;
  };
  numGlyphs: number;
  getEnglishName?: (name: string) => string | undefined;
};

const NAME_PLATFORMS = ["unicode", "windows", "macintosh"] as const;

function flattenName(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferred = record.en || record["en-US"] || record["en-GB"];
    if (typeof preferred === "string" && preferred.trim()) return preferred;
    return Object.values(record)
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join("\n");
  }
  return "";
}

function nameTableValue(names: unknown, key: string): string {
  if (!names || typeof names !== "object") return "";
  const root = names as Record<string, unknown>;
  const parts: string[] = [];
  for (const platform of NAME_PLATFORMS) {
    const table = root[platform];
    if (!table || typeof table !== "object") continue;
    parts.push(flattenName((table as Record<string, unknown>)[key]));
  }
  parts.push(flattenName(root[key]));
  return parts.filter(Boolean).join("\n");
}

function englishName(font: OpenTypeFont, key: string): string {
  const fromApi = font.getEnglishName?.(key)?.trim();
  if (fromApi) return fromApi;
  const raw = nameTableValue(font.names, key);
  return raw.split(/[\n\r]+/).map((line) => line.trim()).find(Boolean) ?? "";
}

function licenseFromFont(font: OpenTypeFont): { license: FontLicense; licenseName: string } {
  const named = [
    englishName(font, "license"),
    nameTableValue(font.names, "licence"),
    englishName(font, "licenseURL"),
    nameTableValue(font.names, "licenceURL"),
  ]
    .filter(Boolean)
    .join("\n");
  const namedHit = classifyLicenseText(named);
  if (namedHit.license !== "unknown") return namedHit;
  const extra = [
    englishName(font, "copyright"),
    englishName(font, "trademark"),
    englishName(font, "manufacturer"),
    englishName(font, "description"),
    englishName(font, "manufacturerURL"),
  ]
    .filter(Boolean)
    .join("\n");
  return classifyLicenseText(extra);
}

function readFvar(font: OpenTypeFont): FontAxis[] {
  const fvar = font.tables.fvar as
    | {
        axes?: Array<{
          tag?: string;
          minValue?: number;
          defaultValue?: number;
          maxValue?: number;
          name?: { en?: string } | string;
        }>;
      }
    | undefined;
  if (!Array.isArray(fvar?.axes) || !fvar.axes.length) return [];
  return fvar.axes
    .filter((axis) => axis.tag && Number.isFinite(axis.minValue) && Number.isFinite(axis.maxValue))
    .map((axis) => {
      const tag = axis.tag as string;
      const name =
        typeof axis.name === "string"
          ? axis.name
          : axis.name && typeof axis.name === "object"
            ? String(axis.name.en ?? "")
            : "";
      return {
        tag,
        name: name || tag,
        min: axis.minValue as number,
        max: axis.maxValue as number,
        def: (axis.defaultValue as number) ?? axis.minValue ?? 0,
      };
    });
}

function flattenInstanceName(name: unknown): string {
  if (!name) return "";
  if (typeof name === "string") return name.trim();
  if (typeof name === "object") {
    const rec = name as Record<string, unknown>;
    const en = rec.en ?? rec["en-US"];
    if (typeof en === "string") return en.trim();
    const first = Object.values(rec).find((v) => typeof v === "string" && v.trim());
    return typeof first === "string" ? first.trim() : "";
  }
  return "";
}

function readInstances(font: OpenTypeFont): { name: string; coords: Record<string, number> }[] {
  const fvar = font.tables.fvar as
    | {
        instances?: Array<{
          name?: unknown;
          coordinates?: Record<string, number>;
          coords?: Record<string, number>;
        }>;
      }
    | undefined;
  if (!Array.isArray(fvar?.instances)) return [];
  return fvar.instances
    .map((inst) => {
      const coords = inst.coordinates ?? inst.coords ?? {};
      return { name: flattenInstanceName(inst.name), coords };
    })
    .filter((inst) => inst.name && Object.keys(inst.coords).length);
}

function variationCodec(font: OpenTypeFont, buffer: ArrayBuffer): string {
  const tables = font.tables as Record<string, unknown>;
  const extras: string[] = [];
  if (tables.avar) extras.push("avar");
  if (tables.hvar || tables.HVAR) extras.push("HVAR");
  if (tables.mvar || tables.MVAR) extras.push("MVAR");
  if (tables.stat || tables.STAT) extras.push("STAT");
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  const magic = String.fromCharCode(head[0] ?? 0, head[1] ?? 0, head[2] ?? 0, head[3] ?? 0);
  if (magic === "wOF2") extras.unshift("WOFF2");
  if (magic === "wOFF") extras.unshift("WOFF");
  let storage = "none";
  if (tables.cff2 || tables.CFF2) storage = "CFF2";
  else if (tables.gvar) storage = "gvar";
  else if (tables.fvar) storage = "fvar";
  const note = extras.length ? `${storage} · ${extras.join(" · ")}` : storage;
  return storage === "none" && !extras.length ? "" : note;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function kerningFingerprint(font: OpenTypeFont): string {
  const tables = font.tables as Record<string, unknown> | undefined;
  if (!tables) return "none";
  const parts: string[] = [];
  const kern = tables.kern as Record<string, unknown> | undefined;
  if (kern && typeof kern === "object") {
    const nPairs = num(kern.nPairs) ?? num(kern.length);
    const sub = Array.isArray(kern.subtables) ? kern.subtables : [];
    const subPairs = sub.reduce((sum, row) => {
      if (!row || typeof row !== "object") return sum;
      const rec = row as Record<string, unknown>;
      return sum + (num(rec.nPairs) ?? (Array.isArray(rec.pairs) ? rec.pairs.length : 0));
    }, 0);
    parts.push(`kern:${nPairs ?? subPairs}:${sub.length}`);
  }
  const gpos = tables.gpos as Record<string, unknown> | undefined;
  if (gpos && typeof gpos === "object") {
    const lookups = Array.isArray(gpos.lookups) ? gpos.lookups.length : num(gpos.lookupCount) ?? 0;
    const scripts = Array.isArray(gpos.scripts) ? gpos.scripts.length : num(gpos.scriptCount) ?? 0;
    const features = Array.isArray(gpos.features) ? gpos.features.length : num(gpos.featureCount) ?? 0;
    parts.push(`gpos:${lookups}:${scripts}:${features}`);
  }
  const kern2 = tables.kerx as Record<string, unknown> | undefined;
  if (kern2 && typeof kern2 === "object") {
    parts.push(`kerx:${num(kern2.nTables) ?? Object.keys(kern2).length}`);
  }
  return parts.join("|") || "none";
}

export async function axesFromBuffer(buffer: ArrayBuffer): Promise<FontAxis[] | null> {
  try {
    const { nativeLayoutFromBytes } = await import("./native-parse");
    const layout = await nativeLayoutFromBytes(buffer);
    if (layout?.axes) return layout.axes;
  } catch {
    /* JS */
  }
  try {
    const faces = await parseSfntCollection(buffer, "font.ttf");
    if (faces[0]?.axes.length) return faces[0].axes;
  } catch {
    /* opentype */
  }
  try {
    const font = await parseOpenType(buffer.slice(0));
    return readFvar(font);
  } catch {
    return null;
  }
}

export async function otFeaturesFromBuffer(buffer: ArrayBuffer): Promise<string[]> {
  try {
    const { nativeLayoutFromBytes } = await import("./native-parse");
    const layout = await nativeLayoutFromBytes(buffer);
    if (layout?.otFeatures?.length) return layout.otFeatures;
  } catch {
    /* JS */
  }
  try {
    const faces = await parseSfntCollection(buffer, "font.ttf");
    if (faces[0]?.otFeatures.length) return faces[0].otFeatures;
  } catch {
    /* opentype */
  }
  try {
    const font = await parseOpenType(buffer.slice(0));
    const gsub = font.tables.gsub as { features?: Array<{ tag?: string }> } | undefined;
    const gpos = font.tables.gpos as { features?: Array<{ tag?: string }> } | undefined;
    return tagsFromLayoutTables(gsub, gpos);
  } catch {
    return [];
  }
}

export async function axesFromFamily(family: string): Promise<FontAxis[] | null> {
  try {
    const { nativeFamilyLayout } = await import("./native-parse");
    const layout = await nativeFamilyLayout(family);
    if (layout?.axes?.length) return layout.axes;
  } catch {
    /* none */
  }
  return null;
}

async function parseOpenType(buffer: ArrayBuffer): Promise<OpenTypeFont> {
  const mod = (await import("opentype.js")) as unknown as {
    parse?: (buffer: ArrayBuffer) => OpenTypeFont;
    default?: { parse: (buffer: ArrayBuffer) => OpenTypeFont };
  };
  const parse = mod.parse ?? mod.default?.parse;
  if (!parse) throw new Error("opentype parse unavailable");
  return parse(buffer);
}

function finishParsed(
  face: {
    family: string;
    subfamily?: string;
    weight: number;
    italic: boolean;
    version: string;
    glyphCount: number;
    licenseText?: string;
    axes: FontAxis[];
    instances: { name: string; coords: Record<string, number> }[];
    otFeatures: string[];
    varStorage: string;
    buffer: ArrayBuffer;
  },
  fileName: string,
  fileSize: number,
  checksum: string,
): ParsedLocalFont {
  const style = inferLocalStyle({
    family: face.family,
    fileName: `${fileName} ${face.subfamily ?? ""}`,
    hasLigatures: face.otFeatures.includes("liga") || face.otFeatures.includes("rlig"),
  });
  const colorKind = primaryColorKind(detectColorTables(face.buffer), face.family);
  const tags = style.tags.slice();
  if (colorKind !== "none" && !tags.includes("color")) tags.push("color");
  if ((colorKind === "colrv1" || colorKind === "cbdt") && !tags.includes("emoji") && /emoji/i.test(face.family)) {
    tags.push("emoji");
  }
  const variable = face.axes.length > 0 || /variable/i.test(face.subfamily ?? "");
  if (variable && !tags.includes("variable")) tags.push("variable");
  const licensed = classifyLicenseText(face.licenseText ?? "");
  return {
    family: face.family,
    weight: guessWeight(face.subfamily ?? "", face.weight),
    italic: face.italic,
    version: face.version,
    glyphCount: face.glyphCount,
    checksum,
    fileName,
    fileSize,
    buffer: face.buffer,
    license: licensed.license,
    licenseName: licensed.licenseName,
    kerningKey: face.otFeatures.includes("kern") || face.otFeatures.includes("vkrn") ? "gpos" : "none",
    category: style.category,
    tags,
    colorKind,
    axes: face.axes,
    variable,
    otFeatures: face.otFeatures,
    instances: face.instances,
    varStorage: face.varStorage,
  };
}

function fromSfntFace(face: SfntFace, fileName: string, fileSize: number, checksum: string): ParsedLocalFont {
  const baseName =
    /\.(woff2?|ttc|otc)$/i.test(fileName) && face.format !== "WOFF2"
      ? fileName.replace(/\.(woff2?|ttc|otc)$/i, face.faceCount > 1 ? `-${face.faceIndex + 1}.ttf` : ".ttf")
      : fileName;
  return finishParsed(
    {
      family: face.family,
      subfamily: face.subfamily,
      weight: face.weight,
      italic: face.italic,
      version: face.version,
      glyphCount: face.glyphCount,
      licenseText: face.licenseText,
      axes: face.axes,
      instances: face.instances,
      otFeatures: face.otFeatures,
      varStorage: face.varStorage,
      buffer: face.buffer,
    },
    baseName,
    fileSize,
    face.faceCount > 1 ? `${checksum}#${face.faceIndex}` : checksum,
  );
}

export async function parseFontCollection(file: File): Promise<ParsedLocalFont[]> {
  const buffer = await file.arrayBuffer();
  const checksum = await sha256Hex(buffer);
  try {
    const faces = await parseSfntCollection(buffer, file.name);
    if (faces.length) {
      return faces.map((face) => fromSfntFace(face, file.name, file.size, checksum));
    }
  } catch {
    /* opentype.js for odd wrappers */
  }
  return [await parseFontFileFromBuffer(file.name, file.size, buffer, checksum)];
}

export async function parseFontFile(file: File): Promise<ParsedLocalFont> {
  const faces = await parseFontCollection(file);
  return faces[0]!;
}

async function parseFontFileFromBuffer(
  fileName: string,
  fileSize: number,
  buffer: ArrayBuffer,
  checksum: string,
): Promise<ParsedLocalFont> {
  const fallbackFamily = fileName.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
  try {
    const font = await parseOpenType(buffer);
    const family =
      englishName(font, "preferredFamily") || englishName(font, "fontFamily") || fallbackFamily;
    const subfamily =
      englishName(font, "preferredSubfamily") || englishName(font, "fontSubfamily") || "";
    const os2 = font.tables.os2 as
      | { usWeightClass?: number; fsSelection?: number; sFamilyClass?: number; panose?: number[] }
      | undefined;
    const italic =
      Boolean(os2?.fsSelection && os2.fsSelection & 0x01) ||
      /italic|oblique/i.test(subfamily);
    const { license, licenseName } = licenseFromFont(font);
    const gsub = font.tables.gsub as { features?: Array<{ tag?: string }> } | undefined;
    const gpos = font.tables.gpos as { features?: Array<{ tag?: string }> } | undefined;
    const otFeatures = tagsFromLayoutTables(gsub, gpos);
    const hasLigatures = otFeatures.includes("liga") || otFeatures.includes("rlig");
    const style = inferLocalStyle({
      family,
      fileName,
      sFamilyClass: os2?.sFamilyClass,
      panose: os2?.panose,
      hasLigatures,
    });
    const colorKind = primaryColorKind(detectColorTables(buffer), family);
    const tags = style.tags.slice();
    if (colorKind !== "none" && !tags.includes("color")) tags.push("color");
    if ((colorKind === "colrv1" || colorKind === "cbdt") && !tags.includes("emoji") && /emoji/i.test(family)) {
      tags.push("emoji");
    }
    const axes = readFvar(font);
    const instances = readInstances(font);
    const varStorage = variationCodec(font, buffer);
    const variable = axes.length > 0 || /variable/i.test(subfamily);
    if (variable && !tags.includes("variable")) tags.push("variable");
    return {
      family,
      weight: guessWeight(subfamily, os2?.usWeightClass),
      italic,
      version: englishName(font, "version"),
      glyphCount: font.numGlyphs,
      checksum,
      fileName,
      fileSize,
      buffer,
      license,
      licenseName,
      kerningKey: kerningFingerprint(font),
      category: style.category,
      tags,
      colorKind,
      axes,
      variable,
      otFeatures,
      instances,
      varStorage,
    };
  } catch {
    const style = inferLocalStyle({ family: fallbackFamily, fileName });
    return {
      family: fallbackFamily,
      weight: 400,
      italic: /italic|oblique/i.test(fileName),
      version: "",
      glyphCount: 0,
      checksum,
      fileName,
      fileSize,
      buffer,
      license: "unknown",
      licenseName: "",
      kerningKey: "none",
      category: style.category,
      tags: style.tags,
      colorKind: primaryColorKind(detectColorTables(buffer), fallbackFamily),
      axes: [],
      variable: false,
      otFeatures: [],
      instances: [],
      varStorage: sniffFontFormat(buffer) === "WOFF2" ? "WOFF2" : "",
    };
  }
}
