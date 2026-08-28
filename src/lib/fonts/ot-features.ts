/** OpenType Layout feature tags (GSUB/GPOS). Defaults match the spec: liga/calt/kern on. */

export const DEFAULT_ON = new Set([
  "liga",
  "clig",
  "calt",
  "kern",
  "locl",
  "rlig",
  "ccmp",
  "mark",
  "mkmk",
  "curs",
]);

/** Layout glue — not useful as user toggles. */
const HIDDEN = new Set(["ccmp", "mark", "mkmk", "rlig", "locl", "size", "aalt", "abvm", "abvs", "akhn", "blwf", "blws", "pref", "pres", "psts"]);

export const FEATURE_LABEL: Record<string, string> = {
  liga: "Ligatures",
  clig: "Contextual ligatures",
  dlig: "Discretionary ligatures",
  calt: "Contextual alts",
  kern: "Kerning",
  smcp: "Small caps",
  c2sc: "Caps → small caps",
  swsh: "Swashes",
  salt: "Stylistic alts",
  tnum: "Tabular nums",
  onum: "Oldstyle nums",
  lnum: "Lining nums",
  pnum: "Proportional nums",
  frac: "Fractions",
  zero: "Slashed zero",
  case: "Case sensitive",
  hist: "Historical forms",
  ordn: "Ordinals",
  sups: "Superscript",
  subs: "Subscript",
  numr: "Numerators",
  dnom: "Denominators",
  ss01: "Stylistic set 1",
  ss02: "Stylistic set 2",
  ss03: "Stylistic set 3",
};

/** Shown when we have not parsed GSUB yet (Google preview). */
export const COMMON_TOGGLES = ["liga", "calt", "kern", "smcp", "tnum", "onum", "frac", "ss01"] as const;

export function labelForFeature(tag: string) {
  if (FEATURE_LABEL[tag]) return FEATURE_LABEL[tag];
  if (/^ss\d{2}$/.test(tag)) return `Stylistic set ${Number(tag.slice(2))}`;
  if (/^cv\d{2}$/.test(tag)) return `Character var ${Number(tag.slice(2))}`;
  return tag;
}

export function tagsFromLayoutTables(
  gsub?: { features?: Array<{ tag?: string }> },
  gpos?: { features?: Array<{ tag?: string }> },
): string[] {
  const seen = new Set<string>();
  for (const table of [gsub, gpos]) {
    for (const feat of table?.features ?? []) {
      const tag = feat?.tag?.trim();
      if (tag) seen.add(tag);
    }
  }
  return [...seen].sort();
}

export function togglesFor(tags: string[] | undefined): string[] {
  if (!tags?.length) return [...COMMON_TOGGLES];
  const user = tags.filter((tag) => !HIDDEN.has(tag));
  if (!user.length) return [...COMMON_TOGGLES];
  const preferred = COMMON_TOGGLES.filter((tag) => user.includes(tag));
  const rest = user.filter((tag) => !preferred.includes(tag as (typeof COMMON_TOGGLES)[number]));
  return [...preferred, ...rest].slice(0, 20);
}

export function featureSettingsCss(values: Record<string, boolean>, tags: string[]): string {
  if (!tags.length) return "normal";
  return tags
    .map((tag) => {
      const on = values[tag] ?? DEFAULT_ON.has(tag);
      return `"${tag}" ${on ? 1 : 0}`;
    })
    .join(", ");
}

function isOn(values: Record<string, boolean>, tag: string) {
  return values[tag] ?? DEFAULT_ON.has(tag);
}

/** Chromium honors font-variant-* more reliably than feature-settings alone. */
export function featureStyle(values: Record<string, boolean>, tags: string[]): Record<string, string> {
  const has = (tag: string) => tags.includes(tag);
  const numeric: string[] = [];
  if (has("tnum") && isOn(values, "tnum")) numeric.push("tabular-nums");
  if (has("pnum") && isOn(values, "pnum")) numeric.push("proportional-nums");
  if (has("onum") && isOn(values, "onum")) numeric.push("oldstyle-nums");
  if (has("lnum") && isOn(values, "lnum")) numeric.push("lining-nums");
  if (has("frac") && isOn(values, "frac")) numeric.push("diagonal-fractions");
  if (has("zero") && isOn(values, "zero")) numeric.push("slashed-zero");
  const liga = !has("liga") || isOn(values, "liga");
  const calt = !has("calt") || isOn(values, "calt");
  const dlig = has("dlig") && isOn(values, "dlig");
  return {
    fontFeatureSettings: featureSettingsCss(values, tags),
    fontVariantLigatures:
      liga || calt || dlig
        ? [
            liga ? "common-ligatures" : "no-common-ligatures",
            calt ? "contextual" : "no-contextual",
            dlig ? "discretionary-ligatures" : "no-discretionary-ligatures",
          ].join(" ")
        : "none",
    fontKerning: has("kern") ? (isOn(values, "kern") ? "normal" : "none") : "auto",
    fontVariantCaps: has("smcp") && isOn(values, "smcp") ? "small-caps" : "normal",
    fontVariantNumeric: numeric.length ? numeric.join(" ") : "normal",
  };
}

/** Text that actually changes when liga / frac / tnum / smcp flip. */
export const FEATURE_DEMO = "Office fi fl 1/2 0123";
