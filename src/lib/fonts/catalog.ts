import { GOOGLE_FONT_SEEDS } from "./catalog-data";
import snapshot from "./google-catalog.json";
import googleDirectory from "./google-directory.json";
import styleMeta from "./google-style.json";
import { googleFontLicense } from "./license";
import { guessGoogleColorKind } from "./color-font";
import { tagsForGoogleFamily } from "./style-tags";
import type { FontCategory, FontRecord } from "./types";

export function googleFontId(family: string) {
  return `g:${family}`;
}

/** Old live caches may still carry catalog "other". Those cards are not shipped. */
export function isFontsourceOnly(font: FontRecord) {
  return font.source === "google" && font.catalog === "other";
}

export function isGoogleCatalog(font: FontRecord) {
  return font.source === "google" && font.catalog !== "other";
}

export function familyKey(name: string) {
  return name.trim().toLowerCase();
}

/** Official fonts.google.com families. Fontsource `type` is not this list. */
export const GOOGLE_DIRECTORY = new Set(
  (Array.isArray(googleDirectory.families) ? googleDirectory.families : []).map((name) =>
    familyKey(String(name)),
  ),
);

export function isOfficialGoogleFamily(family: string) {
  return GOOGLE_DIRECTORY.has(familyKey(family));
}

/** Fontsource WOFF2-only "variable" packs — no google/fonts TTF, never GDI VF. */
export function isWoff2OnlyVariableFamily(family: string) {
  const t = family.trim().toLowerCase();
  return t === "material symbols" || t.startsWith("material symbols ");
}

/**
 * Sidebar Variable facet / `variable` query — catalog claim OR on-disk VF.
 * Same idea as Italic (catalog italic). Card badge / axes stay `font.variable` (disk).
 */
export function isVariableCatalogFamily(font: {
  family: string;
  variable?: boolean;
  catalogVariable?: boolean;
}) {
  if (isWoff2OnlyVariableFamily(font.family)) return false;
  return Boolean(font.variable || font.catalogVariable);
}

type SnapshotRow = [
  family: string,
  category: FontCategory,
  weights: number[],
  italic: boolean,
  variable: boolean,
  popularity: number,
  tags: string[],
];

const SEED_BY_FAMILY = new Map(
  GOOGLE_FONT_SEEDS.map((seed, index) => [seed[0], { seed, index }] as const),
);

function snapshotToRecord(row: SnapshotRow): FontRecord {
  const [family, category, weights, italic, variable, popularity, tags] = row;
  const overlay = SEED_BY_FAMILY.get(family);
  const { license, licenseName } = googleFontLicense(family);
  const official = (styleMeta as Record<string, string[]>)[family] ?? [];
  const mergedTags = tagsForGoogleFamily(family, category, [
    ...official,
    ...(overlay?.seed[5] ?? []),
    ...(Array.isArray(tags) ? tags : []),
  ]);
  return {
    id: googleFontId(family),
    family,
    source: "google",
    catalog: isOfficialGoogleFamily(family) ? "google" : "other",
    category,
    weights: Array.isArray(weights) && weights.length ? weights : [400],
    italic,
    catalogVariable: variable && !isWoff2OnlyVariableFamily(family),
    // Honesty: never badge Variable from catalog alone (disk *-variable-* only).
    variable: false,
    tags: mergedTags,
    popularity: overlay ? overlay.index : 400 + popularity,
    license,
    licenseName,
    colorKind: guessGoogleColorKind(family),
  };
}

const googleRecords = (
  Array.isArray(snapshot.families) ? (snapshot.families as SnapshotRow[]) : []
).map(snapshotToRecord);

/** Official Google Fonts only. Fontsource-exclusive families are not shipped. */
export const GOOGLE_FONTS: FontRecord[] = googleRecords.filter(isGoogleCatalog);

export const FONT_BY_ID = new Map(GOOGLE_FONTS.map((font) => [font.id, font]));

function rebuildAllTags(fonts: FontRecord[]) {
  return Array.from(new Set(fonts.flatMap((font) => font.tags))).sort();
}

export let ALL_TAGS = rebuildAllTags(GOOGLE_FONTS);

export function replaceGoogleCatalog(fonts: FontRecord[]) {
  GOOGLE_FONTS.splice(0, GOOGLE_FONTS.length, ...fonts);
  FONT_BY_ID.clear();
  for (const font of fonts) FONT_BY_ID.set(font.id, font);
  ALL_TAGS = rebuildAllTags(fonts);
}

export const GOOGLE_CATALOG_META = {
  count: GOOGLE_FONTS.length,
  updated: snapshot.updated as string,
  source: "google" as const,
};
