import { FONT_BY_ID, GOOGLE_FONTS, googleFontId, replaceGoogleCatalog } from "./catalog";
import { classifyLicenseText, licenseFromCode } from "./license";
import { guessGoogleColorKind } from "./color-font";
import { tagsForGoogleFamily } from "./style-tags";
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
}

const CATEGORY: Record<string, FontCategory> = {
  "sans-serif": "sans",
  serif: "serif",
  display: "display",
  handwriting: "handwriting",
  monospace: "mono",
};

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

function fromFontsource(item: FontsourceItem, popularity: number, existing?: FontRecord): FontRecord {
  const official = (styleMeta as Record<string, string[]>)[item.family] ?? [];
  const { license, licenseName } = licenseFromSource(item.license);
  const category = CATEGORY[item.category ?? ""] ?? existing?.category ?? "sans";
  return {
    id: googleFontId(item.family),
    family: item.family,
    source: "google",
    category,
    weights: item.weights?.length ? item.weights : existing?.weights ?? [400],
    italic: item.styles?.includes("italic") ?? existing?.italic ?? false,
    variable: Boolean(item.variable) || Boolean(existing?.variable),
    tags: tagsForGoogleFamily(item.family, category, [...official, ...(existing?.tags ?? [])]),
    popularity: existing?.popularity ?? popularity,
    license,
    licenseName,
    colorKind: existing?.colorKind ?? guessGoogleColorKind(item.family),
  };
}

export async function refreshGoogleCatalog(): Promise<{ count: number; added: number } | null> {
  try {
    const res = await fetch("https://api.fontsource.org/v1/fonts");
    if (!res.ok) return null;
    const data = (await res.json()) as FontsourceItem[];
    if (!Array.isArray(data) || data.length < 1000) return null;

    const google = data.filter((item) => item.type === "google" && item.category !== "icons");
    const indexByFamily = new Map(GOOGLE_FONTS.map((font, i) => [font.family, i]));
    const next = GOOGLE_FONTS.slice();
    let added = 0;

    for (const item of google) {
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
        };
        continue;
      }
      added += 1;
      const record = fromFontsource(item, 400 + next.length);
      indexByFamily.set(item.family, next.length);
      next.push(record);
    }

    if (next.length >= GOOGLE_FONTS.length) {
      replaceGoogleCatalog(next);
      return { count: next.length, added };
    }
    return { count: GOOGLE_FONTS.length, added: 0 };
  } catch {
    return null;
  }
}

export function googleFontLookup(id: string): FontRecord | undefined {
  return FONT_BY_ID.get(id);
}
