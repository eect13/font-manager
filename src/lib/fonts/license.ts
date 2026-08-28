import type { FontLicense, FontRecord } from "./types";
import { LICENSE_LABEL, LICENSE_OPTIONS } from "./types";

export type LicenseHit = { license: FontLicense; licenseName: string };

const APACHE_FAMILIES = new Set([
  "Open Sans",
  "Roboto",
  "Roboto Condensed",
  "Roboto Flex",
  "Roboto Mono",
  "Roboto Serif",
  "Roboto Slab",
  "Arimo",
  "Tinos",
  "Cousine",
  "Carlito",
  "Caladea",
  "Gelasio",
  "Droid Sans",
  "Droid Sans Mono",
  "Droid Serif",
  "Droid Sans Thai",
  "Chrome OS",
]);

/**
 * Google Fonts METADATA.pb only allows OFL | APACHE2 | UFL (Font Bakery).
 * Public catalog JSON has no license field — we map known Apache/UFL families,
 * everything else OFL 1.1. Uploads use the name-table / path classifier below.
 */
export function googleFontLicense(family: string): LicenseHit {
  if (family.startsWith("Ubuntu")) {
    return { license: "free", licenseName: "Ubuntu Font License 1.0" };
  }
  if (family.startsWith("Droid") || APACHE_FAMILIES.has(family) || family.startsWith("Roboto") || family.startsWith("Open Sans")) {
    return { license: "free", licenseName: "Apache License 2.0" };
  }
  return { license: "free", licenseName: "SIL Open Font License 1.1" };
}

/** SPDX / METADATA.pb / Fontsource short codes. */
export function licenseFromCode(raw?: string): LicenseHit | null {
  const n = (raw ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (!n) return null;
  if (n === "ofl" || n === "ofl-1.1" || n === "sil-ofl" || n === "sil-open-font-license") {
    return { license: "free", licenseName: "SIL Open Font License 1.1" };
  }
  if (n === "ofl-1.0") return { license: "free", licenseName: "SIL Open Font License 1.0" };
  if (n === "apache" || n === "apache2" || n === "apache-2" || n === "apache-2.0" || n === "asl") {
    return { license: "free", licenseName: "Apache License 2.0" };
  }
  if (n === "ufl" || n === "ufl-1.0" || n === "ubuntu") {
    return { license: "free", licenseName: "Ubuntu Font License 1.0" };
  }
  if (n === "mit") return { license: "free", licenseName: "MIT License" };
  if (n === "cc0" || n === "cc0-1.0") return { license: "free", licenseName: "CC0-1.0" };
  if (n.startsWith("cc-by-nc")) return { license: "personal", licenseName: "CC BY-NC" };
  return null;
}

function norm(text: string): string {
  return text
    .replace(/\u0000/g, " ")
    .replace(/https?:\/\//g, " http://")
    .replace(/[^\S\n]+/g, " ")
    .trim()
    .toLowerCase();
}

type Named = { name: string; test: RegExp };

/** Most specific first. */
const OPEN_LICENSES: Named[] = [
  { name: "SIL Open Font License 1.1", test: /sil open font licen[cs]e\s*(version\s*)?1\.1|\bofl(\s*1\.1)?\b|openfontlicense\.org|scripts\.sil\.org\/ofl/ },
  { name: "SIL Open Font License 1.0", test: /sil open font licen[cs]e\s*(version\s*)?1\.0|\bofl\s*1\.0\b/ },
  { name: "SIL Open Font License 1.1", test: /sil open font licen[cs]e|\blicensed under the ofl\b|\bofl\b/ },
  { name: "Apache License 2.0", test: /apache licen[cs]e[^\n]{0,20}2(\.0)?|apache-2\.0|www\.apache\.org\/licenses\/license-2/ },
  { name: "Apache License 1.1", test: /apache licen[cs]e[^\n]{0,20}1\.1/ },
  { name: "Apache License 2.0", test: /\bapache licen[cs]e\b|\blicensed under apache\b/ },
  { name: "Ubuntu Font License 1.0", test: /ubuntu font licen[cs]e|\bufl\b|ubuntu\.com\/legal\/font/ },
  { name: "MIT License", test: /\bmit licen[cs]e\b|\blicensed under the mit\b|\bthe mit licen[cs]e\b|\bopensource\.org\/licenses\/mit\b/ },
  { name: "BSD-3-Clause", test: /\bbsd[- ]3[- ]clause\b|revised bsd|new bsd licen[cs]e/ },
  { name: "BSD-2-Clause", test: /\bbsd[- ]2[- ]clause\b|simplified bsd/ },
  { name: "BSD License", test: /\bbsd licen[cs]e\b/ },
  { name: "ISC License", test: /\bisc licen[cs]e\b/ },
  { name: "GPL-3.0", test: /gnu general public.{0,32}3|gpl-?3(\.0)?|gplv3/ },
  { name: "GPL-2.0", test: /gnu general public.{0,32}2|gpl-?2(\.0)?|gplv2/ },
  { name: "LGPL-3.0", test: /gnu lesser general.{0,32}3|lgpl-?3|lgplv3/ },
  { name: "LGPL-2.1", test: /gnu lesser general.{0,32}2|lgpl-?2|lgplv2/ },
  { name: "GPL", test: /gnu general public licen[cs]e|\bgpl\b/ },
  { name: "LGPL", test: /gnu lesser general|\blgpl\b/ },
  { name: "CC0-1.0", test: /\bcc0\b|cc[- ]0|creativecommons\.org\/publicdomain\/zero|creative commons.?zero|\bpublic domain\b|\bunlicense\b/ },
  { name: "CC BY-SA", test: /cc[- ]by[- ]sa|creativecommons\.org\/licenses\/by-sa|creative commons.{0,48}share[- ]?alike/ },
  { name: "CC BY-ND", test: /cc[- ]by[- ]nd|creativecommons\.org\/licenses\/by-nd|creative commons.{0,48}no[- ]?deriv/ },
  { name: "CC BY", test: /cc[- ]by(?![- ]nc)|creativecommons\.org\/licenses\/by\/|creative commons attribution(?![\s\S]{0,80}non[- ]?commercial)/ },
  { name: "IPA Font License", test: /ipa font licen[cs]e/ },
  { name: "GNU FreeFont", test: /gnu freefont|gnu free documentation licen[cs]e/ },
];

const CC_NC_RE =
  /cc[- ]by[- ]nc|creativecommons\.org\/licenses\/by-nc|creative commons.{0,48}non[- ]?commercial/;

const PERSONAL_RE =
  /personal use only|free for personal(?![\s\S]{0,32}commercial)|for personal use(?![\s\S]{0,32}commercial)|not for commercial|non[- ]commercial use|no commercial use|(demo|trial|evaluation) (font|version|only)|shareware|1001 ?fonts.{0,24}personal|dafont.{0,24}personal/;

const BOTH_FREE_RE =
  /personal (?:and|&|\/) commercial|free for (?:personal[\s\S]{0,32})?commercial|commercial use (?:is )?(?:allowed|permitted|ok\b)|can be used commercially|free to use (?:for )?(?:any|commercial)|100% free/;

const FREEWARE_RE =
  /\bfreeware\b|closed[- ]source|not open[- ]source|all rights reserved|free (font|typeface)(?![\s\S]{0,24}(ofl|apache|sil))|free (to use|for use|download)|this font is free(?![\s\S]{0,32}(ofl|open font|apache))|free of charge|no cost/;

/** Foundry / paid EULA — avoid OFL boilerplate ("you may not", "font software"). */
const COMMERCIAL_STRONG_RE =
  /\bend[- ]user licen[cs]e agreement\b|(?<![open font ])\beula\b|proprietary font|purchased licen[cs]e|retail licen[cs]e|webfont licen[cs]e required|server licen[cs]e|commercial licen[cs]e required|must (be )?purchas|this font is not freeware|not a freeware|you must (buy|purchase|license)|redistribution.{0,40}(prohibited|forbidden|not permitted)|licensed only to the purchaser|single[- ]user licen[cs]e|myfonts\.com|fonts\.com\/|fontshop\.com|linotype\.com|typenetwork\.com|adobe\.com\/(type|products\/type|fonts)|typekit\.com|font folio/;

const FOUNDRY_RE =
  /\badobe systems\b|\badobe inc\b|\badobe fonts\b|(?:©|copyright|®).{0,64}\badobe\b|\bmonotype imaging\b|\bmonotype\b|\blinotype\b|\bhoefler\b|\btypography\.com\b|\bfontfont\b|\bhouse industries\b|\bcommercial type\b|\bfont bureau\b|\btypekit\b|\bitc[\s-]font\b|\bemigre\b|\bds type\b|\bprocess type\b/;

const FOUNDRY_PATH_RE =
  /\badobe fonts\b|\btypekit\b|\bcreative cloud fonts\b|\bmonotype\b|\blinotype\b|\bmyfonts\b|\bfontshop\b|\bfonts\.com\b|\btypenetwork\b|\bhoefler\b|\btypography\.com\b|\bfontfont\b|\bhouse industries\b|\bcommercial type\b|\bfont bureau\b|\bfont folio\b/;

const PERSONAL_PATH_RE =
  /personal[- _]?use|free[- _]?for[- _]?personal|not[- _]?for[- _]?commercial|demo[- _]?font|trial[- _]?font|1001fonts|dafont|urbanfonts|fontspace|abstractfonts|befonts|fonts2u/;

const FREE_PATH_RE =
  /\bofl\b|open[- _]?font[- _]?license|sil\.org|fontsource|google[- _]?fonts|apache[- _]?license|\blicense[- _]?mit\b|\bfonts\.google\.com\b/;

function firstMeaningfulLine(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const withoutUrl = compact
    .split(/(?=https?:\/\/)/i)
    .map((part) => part.trim())
    .find((part) => part.length > 3 && !/^https?:\/\//i.test(part)) ?? compact;
  const sentence = withoutUrl.match(/^(.+?[.!?])(?:\s|$)/);
  let out = (sentence?.[1] ?? withoutUrl).trim();
  if (out.length > 160) {
    out = out.slice(0, 160).replace(/\s+\S*$/, "").trim();
  }
  return out;
}

function detectOpenLicense(hay: string): string | null {
  for (const item of OPEN_LICENSES) {
    if (item.test.test(hay)) return item.name;
  }
  return null;
}

function fromUrl(hay: string): LicenseHit | null {
  if (/scripts\.sil\.org\/ofl|openfontlicense\.org/.test(hay)) {
    return { license: "free", licenseName: "SIL Open Font License 1.1" };
  }
  if (/apache\.org\/licenses\/license-2/.test(hay)) {
    return { license: "free", licenseName: "Apache License 2.0" };
  }
  if (/creativecommons\.org\/publicdomain\/zero/.test(hay)) {
    return { license: "free", licenseName: "CC0-1.0" };
  }
  if (/creativecommons\.org\/licenses\/by-nc/.test(hay)) {
    return { license: "personal", licenseName: "CC BY-NC" };
  }
  if (/creativecommons\.org\/licenses\/by-sa/.test(hay)) {
    return { license: "free", licenseName: "CC BY-SA" };
  }
  if (/creativecommons\.org\/licenses\/by\//.test(hay)) {
    return { license: "free", licenseName: "CC BY" };
  }
  if (/opensource\.org\/licenses\/mit|mit-license\.org/.test(hay)) {
    return { license: "free", licenseName: "MIT License" };
  }
  if (/ubuntu\.com\/legal\/font/.test(hay)) {
    return { license: "free", licenseName: "Ubuntu Font License 1.0" };
  }
  return null;
}

/**
 * Classify name-table / EULA text.
 *
 * 1. License URL (strongest)
 * 2. Named open license — wins over foundry copyright
 * 3. CC BY-NC / personal-only
 * 4. Explicit personal+commercial freeware
 * 5. Paid EULA / foundry
 * 6. Unknown
 */
export function classifyLicenseText(text: string): LicenseHit {
  const raw = text.trim();
  if (!raw) return { license: "unknown", licenseName: "" };
  const coded = licenseFromCode(raw);
  if (coded) return coded;
  const hay = norm(raw);

  const urlHit = fromUrl(hay);
  if (urlHit) return urlHit;

  const openName = detectOpenLicense(hay);
  const ccNc = CC_NC_RE.test(hay);
  const bothFree = BOTH_FREE_RE.test(hay);
  const freeware = FREEWARE_RE.test(hay);
  const personal = PERSONAL_RE.test(hay) && !bothFree;
  const commercialStrong = COMMERCIAL_STRONG_RE.test(hay);
  const foundry = FOUNDRY_RE.test(hay);

  if (ccNc) {
    return { license: "personal", licenseName: "CC BY-NC" };
  }
  if (openName) {
    if (personal && !bothFree && /non[- ]commercial/.test(hay)) {
      return { license: "personal", licenseName: openName };
    }
    return { license: "free", licenseName: openName };
  }
  if (personal) {
    return { license: "personal", licenseName: firstMeaningfulLine(raw) || "Personal use" };
  }
  if (commercialStrong) {
    return { license: "commercial", licenseName: firstMeaningfulLine(raw) || "Commercial license" };
  }
  if (foundry && !bothFree && !freeware) {
    return { license: "commercial", licenseName: firstMeaningfulLine(raw) || "Commercial foundry" };
  }
  if (bothFree || freeware) {
    return { license: "freeware", licenseName: firstMeaningfulLine(raw) || "Freeware (closed source)" };
  }
  return { license: "unknown", licenseName: firstMeaningfulLine(raw) };
}

export function classifyLicenseHints(opts: {
  fileName?: string;
  relativePath?: string;
  collectionName?: string;
  collectionNames?: string[];
}): LicenseHit | null {
  const hay = norm(
    [opts.fileName, opts.relativePath, opts.collectionName, ...(opts.collectionNames ?? [])]
      .filter(Boolean)
      .join(" "),
  );
  if (!hay) return null;
  const urlHit = fromUrl(hay);
  if (urlHit) return urlHit;
  if (PERSONAL_PATH_RE.test(hay)) {
    return { license: "personal", licenseName: "Personal use" };
  }
  const openName = detectOpenLicense(hay);
  if (openName) return { license: "free", licenseName: openName };
  if (FREE_PATH_RE.test(hay)) {
    return { license: "free", licenseName: "Open license" };
  }
  if (/\bfreeware\b|closed[- ]source|all rights reserved/.test(hay)) {
    return { license: "freeware", licenseName: "Freeware (closed source)" };
  }
  if (FOUNDRY_PATH_RE.test(hay)) {
    return { license: "commercial", licenseName: "Commercial foundry" };
  }
  return null;
}

export function refineLicense(
  current: { license: FontLicense; licenseName?: string; fileName?: string },
  hints?: {
    fileName?: string;
    relativePath?: string;
    collectionName?: string;
    collectionNames?: string[];
  },
): LicenseHit {
  const fromText = classifyLicenseText(
    [current.licenseName ?? "", current.fileName ?? ""].filter(Boolean).join("\n"),
  );
  const hinted = classifyLicenseHints({
    fileName: hints?.fileName ?? current.fileName,
    relativePath: hints?.relativePath,
    collectionName: hints?.collectionName,
    collectionNames: hints?.collectionNames,
  });

  const rank: Record<FontLicense, number> = {
    free: 5,
    personal: 4,
    freeware: 3,
    commercial: 2,
    unknown: 0,
  };

  let best: LicenseHit = fromText;
  if (hinted && rank[hinted.license] > rank[best.license]) {
    best = hinted;
  } else if (hinted && best.license === "unknown") {
    best = hinted;
  } else if (hinted && best.license === hinted.license && !best.licenseName) {
    best = { license: best.license, licenseName: hinted.licenseName };
  }

  if (best.license !== "unknown") {
    return { license: best.license, licenseName: firstMeaningfulLine(best.licenseName) || best.licenseName };
  }
  if (current.license && current.license !== "unknown") {
    return {
      license: coerceLicense(current.license),
      licenseName: firstMeaningfulLine(current.licenseName ?? "") || current.licenseName || "",
    };
  }
  return {
    license: "unknown",
    licenseName: firstMeaningfulLine(current.licenseName ?? "") || current.licenseName || "",
  };
}

export function fontLicense(font: FontRecord): FontLicense {
  return coerceLicense(font.license);
}

export function coerceLicense(value: unknown): FontLicense {
  return LICENSE_OPTIONS.includes(value as FontLicense) ? (value as FontLicense) : "unknown";
}

export function licenseSearchHay(font: FontRecord): string {
  return [fontLicense(font), LICENSE_LABEL[fontLicense(font)], font.licenseName ?? ""].join(" ");
}

export function sortByLicenseBucket<T extends { license?: FontLicense }>(items: T[]): T[] {
  const rank = new Map(LICENSE_OPTIONS.map((id, i) => [id, i]));
  return [...items].sort(
    (a, b) => (rank.get(a.license ?? "unknown") ?? 9) - (rank.get(b.license ?? "unknown") ?? 9),
  );
}
