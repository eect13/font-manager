import { toast } from "sonner";
import type { FontRecord } from "./types";
import { isEmojiFamily } from "./emoji";

/** OpenType color methods we care about. */
export type ColorKind = "none" | "colrv0" | "colrv1" | "svg" | "cbdt" | "sbix";

function tagAt(bytes: Uint8Array, i: number) {
  if (i + 4 > bytes.length) return "";
  return String.fromCharCode(bytes[i]!, bytes[i + 1]!, bytes[i + 2]!, bytes[i + 3]!);
}

function u16(view: DataView, offset: number) {
  if (offset + 2 > view.byteLength) return 0;
  return view.getUint16(offset, false);
}

function u32(view: DataView, offset: number) {
  if (offset + 4 > view.byteLength) return 0;
  return view.getUint32(offset, false);
}

function sfntTables(bytes: Uint8Array): Map<string, { offset: number; length: number }> {
  const out = new Map<string, { offset: number; length: number }>();
  if (bytes.length < 12) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = tagAt(bytes, 0);
  if (magic === "wOF2") return out;
  if (magic === "wOFF") {
    const n = u16(view, 12);
    let p = 44;
    for (let i = 0; i < n && p + 20 <= bytes.length; i += 1, p += 20) {
      out.set(tagAt(bytes, p), { offset: u32(view, p + 4), length: u32(view, p + 12) });
    }
    return out;
  }
  const n = u16(view, 4);
  let p = 12;
  for (let i = 0; i < n && p + 16 <= bytes.length; i += 1, p += 16) {
    out.set(tagAt(bytes, p), { offset: u32(view, p + 8), length: u32(view, p + 12) });
  }
  return out;
}

function colrVersion(bytes: Uint8Array, table: { offset: number; length: number } | undefined) {
  if (!table || table.length < 2 || table.offset + 2 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return u16(view, table.offset);
}

export function detectColorTables(buffer: ArrayBuffer | Uint8Array): ColorKind[] {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const tables = sfntTables(bytes);
  const kinds: ColorKind[] = [];
  if (tables.has("COLR") || tables.has("CPAL")) {
    const v = colrVersion(bytes, tables.get("COLR"));
    kinds.push(v === 1 ? "colrv1" : "colrv0");
  }
  if (tables.has("SVG ")) kinds.push("svg");
  if (tables.has("CBDT") || tables.has("CBLC")) kinds.push("cbdt");
  if (tables.has("sbix")) kinds.push("sbix");
  return kinds;
}

export function primaryColorKind(kinds: ColorKind[], family?: string): ColorKind {
  if (kinds.includes("colrv1")) return "colrv1";
  if (kinds.includes("svg")) return "svg";
  if (kinds.includes("cbdt")) return "cbdt";
  if (kinds.includes("colrv0")) return "colrv0";
  if (kinds.includes("sbix")) return "sbix";
  if (family && /color emoji/i.test(family)) return "colrv1";
  if (family && isEmojiFamily(family)) return "cbdt";
  return "none";
}

export function colorKindLabel(kind: ColorKind) {
  switch (kind) {
    case "colrv1":
      return "COLRv1 color vectors";
    case "colrv0":
      return "COLRv0 layered color";
    case "svg":
      return "OpenType-SVG";
    case "cbdt":
      return "CBDT color bitmaps";
    case "sbix":
      return "Apple sbix color";
    default:
      return "";
  }
}

/**
 * Chromium (this app, Edge, Chrome) paints COLRv1. GDI never does. DirectWrite
 * on Windows 10 paints COLRv0 / CBDT / sbix / a subset of OT-SVG; COLRv1 in
 * Win32 apps is reliable on Windows 11.
 */
export function windowsColorNote(kind: ColorKind) {
  switch (kind) {
    case "colrv1":
      return "This window/Chrome/Edge: color. Word & Adobe: we also install a same-name outline file so the family still types. Color in Word is Windows 11 DirectWrite; Adobe prefers OpenType-SVG (we try that too). Word may still swap emoji for Segoe — pick the family in the font list, not the emoji picker.";
    case "svg":
      return "Adobe Illustrator/Photoshop and some Word/DirectWrite paths show OpenType-SVG color. We also install outlines so every computer can still set the family.";
    case "cbdt":
      return "Windows Word (DirectWrite) can show CBDT color. Adobe and GDI need the outline fallback we install under the same family name.";
    case "colrv0":
      return "Word and many apps since Windows 8.1 can show COLRv0 color. Adobe is mixed; outlines are always installed as backup.";
    case "sbix":
      return "Color on macOS. On Windows, DirectWrite (Word) may show it; Adobe usually needs outlines, which we install.";
    default:
      return "";
  }
}

export function shouldWarnColor(kind: ColorKind) {
  return kind === "colrv1" || kind === "svg" || kind === "cbdt" || kind === "sbix";
}

const notified = new Set<string>();

export function takeColorNotice(font: Pick<FontRecord, "id" | "family">, where: string) {
  const key = `${font.id}:${where}`;
  if (notified.has(key)) return false;
  notified.add(key);
  return true;
}

export function guessGoogleColorKind(family: string): ColorKind {
  const n = family.toLowerCase();
  if (n.includes("noto color emoji")) return "colrv1";
  if (n.includes("emoji")) return "cbdt";
  if (
    n === "nabla" ||
    n === "bungee spice" ||
    n === "honk" ||
    n === "kablammo" ||
    n === "blaka ink" ||
    n === "foldit" ||
    n === "linefont" ||
    n === "moirai" ||
    n === "moirai one"
  ) {
    return "colrv1";
  }
  return "none";
}

export function isSpecialPreviewFont(font: Pick<FontRecord, "family" | "tags" | "colorKind">) {
  if (isEmojiFamily(font.family)) return true;
  if ((font.tags ?? []).includes("color") || (font.tags ?? []).includes("emoji")) return true;
  return colorKindOf(font) !== "none";
}

export function colorKindOf(font: Pick<FontRecord, "family" | "colorKind">): ColorKind {
  if (font.colorKind && font.colorKind !== "none") return font.colorKind;
  return guessGoogleColorKind(font.family);
}

export function notifyIfUnusual(
  font: Pick<FontRecord, "id" | "family" | "colorKind">,
  where: "activate" | "preview" | "glyphs",
) {
  const kind = colorKindOf(font);
  if (!shouldWarnColor(kind)) return;
  if (!takeColorNotice(font, where)) return;
  const note = windowsColorNote(kind);
  if (!note) return;
  const title =
    where === "glyphs"
      ? `${font.family} uses ${colorKindLabel(kind)}`
      : `${font.family} is not a regular outline font`;
  toast.message(title, { description: note, duration: 14_000 });
}
