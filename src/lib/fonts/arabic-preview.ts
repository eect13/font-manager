/**
 * FORM-S12 §4: preview for Arabic-primary fonts.
 *
 * Line 1 is the Arabic pangram (rtl, ar). Line 2 is the user's sample at 0.5em
 * (ltr, en), only when the face covers Latin: cmap A–Z/a–z ≥ 90 % at import, or
 * the Google catalog's `latin` subset. Arabic-only faces show line 1 only.
 * Latin-primary faces (Rubik, Cascadia Code, Arial …) return null and keep the
 * user's sample, unchanged.
 *
 * Arabic-primary = `scriptKindOf` is arabic, which covers: the name map, the
 * catalog's primaryScript "Arab", an upload or system name matching
 * `ARABIC_NAME` (uploads also need Arabic in the cmap), and a cmap with
 * Arabic but no Latin. No glyph-count ratio.
 */
import { catalogHasLatinSubset } from "./primary-script";
import { ARABIC_PANGRAM, scriptKindOf, type ScriptTarget } from "./scripts";

export { ARABIC_PANGRAM };

type ArabicTarget = Exclude<ScriptTarget, string> & { coversLatin?: boolean; tags?: string[] };

export interface PreviewLine {
  text: string;
  dir: "rtl" | "ltr";
  lang: string;
}

export interface ArabicPreviewLines {
  primary: PreviewLine;
  secondary?: PreviewLine;
}

/** U+0600–06FF, 0750–077F, 08A0–08FF, FB50–FDFF, FE70–FEFF. */
const ARABIC_TEXT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export function isArabicPrimary(font: ArabicTarget): boolean {
  return scriptKindOf(font) === "arabic";
}

function faceCoversLatin(font: ArabicTarget): boolean {
  if (typeof font.coversLatin === "boolean") return font.coversLatin;
  return catalogHasLatinSubset(font.family);
}

/** The two preview lines for an Arabic-primary face, or null to keep today's preview. */
export function arabicPreviewLines(font: ArabicTarget, sample: string): ArabicPreviewLines | null {
  if (!isArabicPrimary(font)) return null;
  if (ARABIC_TEXT.test(sample)) return { primary: { text: sample, dir: "rtl", lang: "ar" } };
  const primary: PreviewLine = { text: ARABIC_PANGRAM, dir: "rtl", lang: "ar" };
  const text = sample.trim() ? sample : "";
  if (!text || !faceCoversLatin(font)) return { primary };
  return { primary, secondary: { text, dir: "ltr", lang: "en" } };
}
