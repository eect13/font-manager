import type { FontCategory } from "./types";
import { readPanose } from "./panose";

function push(tags: string[], tag: string) {
  if (!tags.includes(tag)) tags.push(tag);
}

/** Free/shareware hosts that often ship dummy or template OS/2 PANOSE. */
export const UNTRUSTED_FONT_SOURCES = [
  "Dafont",
  "1001 Fonts",
  "FontSpace",
  "UrbanFonts",
  "Abstract Fonts",
  "Befonts",
  "Fonts2u",
  "FontZone",
  "FFonts",
  "FontPalace",
  "FontGarden",
  "CoolText",
  "SearchFreeFonts",
  "GetFreeFonts",
  "FontMeme",
  "FontTr",
  "Free-Fonts",
] as const;

function marketplaceHay(hay: string) {
  return /dafont|1001fonts|urbanfonts|abstractfonts|befonts|fontspace|fontsquirrel|fonts2u|fontzone|ffonts|fontpalace|fontgarden|cooltext|searchfreefonts|getfreefonts|fontmeme|fonttr|free-?fonts|freefonts?/i.test(
    hay,
  );
}

type NameHit = { category: FontCategory; tags: string[]; strong: boolean };

function categoryFromName(hay: string): NameHit | null {
  const tags: string[] = [];
  if (/\b(dingbat|dingbats|symbol|ornament|initials|icon[- ]?set|barcode)\b/i.test(hay)) {
    return { category: "display", tags: ["symbols"], strong: true };
  }
  if (
    /\b(script|handwriting|hand[- ]?letter(?:ing)?|calligraph(?:y|ic)?|signature|cursive)\b/i.test(hay) ||
    /\bbrush script\b/i.test(hay)
  ) {
    return { category: "handwriting", tags: ["script"], strong: true };
  }
  if (/\b(mono|monospace|typewriter|console|fixed[- ]?width)\b/i.test(hay) || /\bcode\b/i.test(hay)) {
    return { category: "mono", tags: ["coding"], strong: true };
  }
  if (
    /\b(display|poster|blackletter|graffiti|comic|decorative|titling|headline|stencil|inline|outline|vintage|western)\b/i.test(
      hay,
    )
  ) {
    return { category: "display", tags, strong: true };
  }
  if (/\bsans([- ]serif)?\b/i.test(hay) || /\b(gothic|grotesk|grotesque)\b/i.test(hay)) {
    return { category: "sans", tags, strong: true };
  }
  if (/\bserif\b/i.test(hay)) {
    return { category: "serif", tags, strong: true };
  }
  if (/\b(slab|clarendon|rockwell|egyptienne)\b/i.test(hay)) {
    return { category: "serif", tags: ["slab"], strong: true };
  }
  if (/\b(garamond|caslon|baskerville|bodoni|didot|times|georgia|palatino)\b/i.test(hay)) {
    return { category: "serif", tags: ["editorial"], strong: false };
  }
  return null;
}

const EXTRA_TAGS: [RegExp, string][] = [
  [/geometric|futura|avant|century gothic|poppins|montserrat|gilroy|circular/i, "geometric"],
  [/humanist|gill|myriad|frutiger|verdana|tahoma|source sans|optima/i, "humanist"],
  [/neo[- ]?grotesque|helvetica|arial|roboto|inter|neue|geist|univers/i, "neo-grotesque"],
  [/grotesque|grotesk|akzidenz|franklin/i, "grotesque"],
  [/editorial|garamond|caslon|baskerville|merriweather|eb garamond|crimson/i, "editorial"],
  [/condens|narrow|compressed/i, "condensed"],
  [/slab|rockwell|clarendon|arvo|zilla/i, "slab"],
  [/didone|bodoni|didot|playfair/i, "didone"],
  [/round|nunito|comfortaa|quicksand|varela round/i, "rounded"],
  [/atkinson|lexend|hyperlegible|dyslex/i, "accessible"],
  [/noto/i, "noto"],
  [/colrv?1|\bemoji\b/i, "color"],
];

function ibmClass(sFamilyClass?: number) {
  if (sFamilyClass == null) return 0;
  return (sFamilyClass >> 8) & 0xff;
}

function ibmSubclass(sFamilyClass?: number) {
  if (sFamilyClass == null) return 0;
  return sFamilyClass & 0xff;
}

function fromIbm(cls: number, sub: number): { category: FontCategory; tags: string[] } | null {
  const tags: string[] = [];
  if (cls === 0) return null;
  if (cls === 10) return { category: "handwriting", tags: ["script"] };
  if (cls === 11) return { category: "display", tags: ["symbols"] };
  if (cls === 9) return { category: "display", tags };
  if (cls === 5) return { category: "serif", tags: ["slab"] };
  if (cls === 3) return { category: "serif", tags: ["didone"] };
  if (cls === 1 || cls === 2) return { category: "serif", tags: ["editorial"] };
  if (cls >= 1 && cls <= 7) return { category: "serif", tags };
  if (cls === 8) {
    if (sub === 9) return { category: "mono", tags: ["coding"] };
    if (sub === 2) tags.push("humanist");
    else if (sub === 1 || sub === 5 || sub === 6) tags.push("neo-grotesque");
    else if (sub === 3 || sub === 4) tags.push("geometric");
    return { category: "sans", tags };
  }
  return null;
}

/**
 * Uploads (especially Dafont): file name wins. PANOSE/IBM only if they look filled in
 * and the name does not already say script / mono / display / sans / serif.
 */
export function inferLocalStyle(input: {
  family: string;
  fileName?: string;
  sFamilyClass?: number;
  panose?: number[];
  hasLigatures?: boolean;
}): { category: FontCategory; tags: string[]; fromName: boolean } {
  const hay = `${input.family} ${input.fileName ?? ""}`;
  const tags: string[] = [];
  const named = categoryFromName(hay);
  const panose = readPanose(input.panose);
  const untrusted = marketplaceHay(hay);
  const ibm = fromIbm(ibmClass(input.sFamilyClass), ibmSubclass(input.sFamilyClass));

  let category: FontCategory = "sans";
  if (named?.strong) {
    category = named.category;
    for (const t of named.tags) push(tags, t);
  } else if (!untrusted && panose.confident && panose.category) {
    category = panose.category;
  } else if (!untrusted && ibm) {
    category = ibm.category;
    for (const t of ibm.tags) push(tags, t);
  } else if (named) {
    category = named.category;
    for (const t of named.tags) push(tags, t);
  } else if (panose.category && panose.confident) {
    category = panose.category;
  }

  if (named && !named.strong) {
    for (const t of named.tags) push(tags, t);
  }
  if (!untrusted) {
    for (const t of panose.tags) push(tags, t);
    if (ibm) for (const t of ibm.tags) push(tags, t);
  }
  for (const [re, tag] of EXTRA_TAGS) {
    if (re.test(hay)) push(tags, tag);
  }
  if (input.hasLigatures) push(tags, "ligatures");
  if (category === "handwriting") push(tags, "script");
  if (category === "mono") push(tags, "coding");

  return { category, tags, fromName: Boolean(named?.strong) };
}

const CATEGORY_AS_TAG: Record<FontCategory, Set<string>> = {
  sans: new Set(["sans"]),
  serif: new Set(["serif"]),
  display: new Set(["display"]),
  handwriting: new Set(["handwriting", "script"]),
  mono: new Set(["monospace", "mono"]),
};

export function tagsForGoogleFamily(
  family: string,
  category: FontCategory,
  extra: string[] = [],
): string[] {
  const inferred = inferLocalStyle({ family, fileName: family });
  const skip = CATEGORY_AS_TAG[category] ?? new Set();
  const out: string[] = [];
  for (const tag of [...extra, ...inferred.tags]) {
    const t = tag.trim().toLowerCase();
    if (!t || skip.has(t)) continue;
    push(out, t);
  }
  return out;
}
