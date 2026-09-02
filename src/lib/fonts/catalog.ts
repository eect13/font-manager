import { GOOGLE_FONT_SEEDS } from "./catalog-data";
import snapshot from "./google-catalog.json";
import googleDirectory from "./google-directory.json";
import otherSnapshot from "./fontsource-other.json";
import styleMeta from "./google-style.json";
import { googleFontLicense, licenseFromCode } from "./license";
import { guessGoogleColorKind } from "./color-font";
import { tagsForGoogleFamily } from "./style-tags";
import type { FontCategory, FontRecord } from "./types";

export function googleFontId(family: string) {
  return `g:${family}`;
}

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

type SnapshotRow = [
  family: string,
  category: FontCategory,
  weights: number[],
  italic: boolean,
  variable: boolean,
  popularity: number,
  tags: string[],
];

type OtherRow = [
  family: string,
  category: FontCategory,
  weights: number[],
  italic: boolean,
  variable: boolean,
  popularity: number,
  tags: string[],
  license?: string,
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
    variable,
    tags: mergedTags,
    popularity: overlay ? overlay.index : 400 + popularity,
    license,
    licenseName,
    colorKind: guessGoogleColorKind(family),
  };
}

function otherToRecord(row: OtherRow): FontRecord {
  const [family, category, weights, italic, variable, popularity, tags, license] = row;
  const hit = licenseFromCode(license) ?? {
    license: "free" as const,
    licenseName: "SIL Open Font License 1.1",
  };
  return {
    id: googleFontId(family),
    family,
    source: "google",
    catalog: "other",
    category,
    weights: Array.isArray(weights) && weights.length ? weights : [400],
    italic,
    variable,
    tags: tagsForGoogleFamily(family, category, Array.isArray(tags) ? tags : []),
    popularity,
    license: hit.license,
    licenseName: hit.licenseName,
    colorKind: guessGoogleColorKind(family),
  };
}

const googleRecords = (
  Array.isArray(snapshot.families) ? (snapshot.families as SnapshotRow[]) : []
).map(snapshotToRecord);

const googleNames = new Set(googleRecords.map((font) => font.family.toLowerCase()));

const otherRecords = (
  Array.isArray(otherSnapshot.families) ? (otherSnapshot.families as OtherRow[]) : []
)
  .map(otherToRecord)
  .filter((font) => !googleNames.has(font.family.toLowerCase()));

export const GOOGLE_FONTS: FontRecord[] = [...googleRecords, ...otherRecords];

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
  fontsourceOther: otherSnapshot.count as number,
};
