import { GOOGLE_FONT_SEEDS } from "./catalog-data";
import snapshot from "./google-catalog.json";
import styleMeta from "./google-style.json";
import { googleFontLicense } from "./license";
import { guessGoogleColorKind } from "./color-font";
import { tagsForGoogleFamily } from "./style-tags";
import type { FontCategory, FontRecord } from "./types";

export function googleFontId(family: string) {
  return `g:${family}`;
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
    catalog: "google",
    category,
    weights: Array.isArray(weights) && weights.length ? weights : [400],
    italic,
    variable,
    tags: mergedTags,
    popularity: overlay ? overlay.index : 400 + popularity,
    license,
    licenseName,
    colorKind: guessGoogleColorKind(family),
  };
}

export const GOOGLE_FONTS: FontRecord[] = (
  Array.isArray(snapshot.families) ? (snapshot.families as SnapshotRow[]) : []
).map(snapshotToRecord);

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
  count: snapshot.count as number,
  updated: snapshot.updated as string,
  source: snapshot.source as string,
};
