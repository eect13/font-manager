/**
 * FORM-S12 §4: Google's own `primaryScript` (fonts.google.com/metadata/fonts),
 * shipped in `google-catalog.json` by `scripts/regen-shipped-catalogs.mjs`.
 * Only "Arab" is stored and read: 39 of the 50 Arab-primary families are not
 * Arabic by name (Alexandria, Mada, Vazirmatn …) and would otherwise preview Latin.
 */
import catalog from "./google-catalog.json" with { type: "json" };

const data = catalog as { primaryScript?: Record<string, string>; latinSubset?: string[] };
const key = (family: string) => family.trim().toLowerCase();
const PRIMARY = new Map(Object.entries(data.primaryScript ?? {}).map(([family, script]) => [key(family), script]));
const LATIN_SUBSET = new Set((data.latinSubset ?? []).map(key));

/** Google's primaryScript for a catalog family ("Arab"), or undefined. */
export function catalogPrimaryScript(family: string): string | undefined {
  return PRIMARY.get(key(family));
}

/** True when an Arab-primary catalog family also ships a `latin` subset. */
export function catalogHasLatinSubset(family: string): boolean {
  return LATIN_SUBSET.has(key(family));
}
