#!/usr/bin/env node
/**
 * Refresh shipped catalog snapshots from live APIs (cache: no-store).
 * Writes google-directory.json, google-catalog.json, fontsource-other.json.
 *
 * Usage: node scripts/regen-shipped-catalogs.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src/lib/fonts");

const FONTSOURCE_LIST = "https://api.fontsource.org/v1/fonts";
const GOOGLE_META = "https://fonts.google.com/metadata/fonts";

const CATEGORY_FS = {
  "sans-serif": "sans",
  serif: "serif",
  display: "display",
  handwriting: "handwriting",
  monospace: "mono",
  other: "other",
  icons: "icons",
};

const CATEGORY_GOOGLE = {
  "Sans Serif": "sans",
  Serif: "serif",
  Display: "display",
  Handwriting: "handwriting",
  Monospace: "mono",
};

function familyKey(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase();
}

function updatedStamp() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}Z`;
}

function tagsForCategory(category, family) {
  const tags = [];
  if (category === "display") tags.push("display");
  if (category === "handwriting") tags.push("handwriting");
  if (category === "mono") tags.push("monospace");
  if (category === "icons") tags.push("symbols");
  if (/^noto\b/i.test(family) || /\bnoto\b/i.test(family)) tags.push("noto");
  return tags;
}

function weightsFromGoogleFonts(fonts) {
  const weights = new Set();
  for (const key of Object.keys(fonts ?? {})) {
    const n = Number.parseInt(key, 10);
    if (Number.isFinite(n) && n > 0) weights.add(n);
  }
  return [...weights].sort((a, b) => a - b);
}

function italicFromGoogleFonts(fonts) {
  return Object.keys(fonts ?? {}).some((k) => /i$/i.test(k));
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res;
}

async function main() {
  const [fsRes, gRes] = await Promise.all([
    fetchJson(FONTSOURCE_LIST),
    fetchJson(GOOGLE_META),
  ]);
  const fontsource = await fsRes.json();
  if (!Array.isArray(fontsource) || fontsource.length < 1000) {
    throw new Error(`Fontsource list too small: ${fontsource?.length}`);
  }
  const gText = await gRes.text();
  const googleMeta = JSON.parse(gText.replace(/^\)\]\}'\n?/, ""));
  const metaList = googleMeta.familyMetadataList ?? [];
  if (metaList.length < 1000) {
    throw new Error(`Google metadata too small: ${metaList.length}`);
  }

  const dirFamilies = metaList.map((item) => item.family).filter(Boolean);
  const dirKeys = new Set(dirFamilies.map(familyKey));
  const fsByFamily = new Map(fontsource.map((item) => [item.family, item]));

  const updated = updatedStamp();

  const directory = {
    updated,
    source: "fonts.google.com/metadata/fonts (live)",
    count: dirFamilies.length,
    families: dirFamilies,
  };

  const googleFamilies = [];
  for (const item of metaList) {
    const family = item.family;
    if (!family) continue;
    const fs = fsByFamily.get(family);
    const category =
      CATEGORY_GOOGLE[item.category] ??
      CATEGORY_FS[fs?.category ?? ""] ??
      "sans";
    const weights =
      fs?.weights?.length > 0
        ? [...fs.weights].sort((a, b) => a - b)
        : weightsFromGoogleFonts(item.fonts);
    const italic = fs?.styles?.includes("italic") ?? italicFromGoogleFonts(item.fonts);
    const variable = Boolean(fs?.variable) || (Array.isArray(item.axes) && item.axes.length > 0);
    const popularity = typeof item.popularity === "number" ? item.popularity : 9999;
    const tags = tagsForCategory(category, family);
    googleFamilies.push([
      family,
      category,
      weights.length ? weights : [400],
      Boolean(italic),
      Boolean(variable),
      popularity,
      tags,
    ]);
  }

  const googleCatalog = {
    updated,
    source: "fonts.google.com/metadata/fonts + api.fontsource.org/v1/fonts (live)",
    count: googleFamilies.length,
    families: googleFamilies,
  };

  const exclusive = [];
  let exclusiveIdx = 0;
  for (let fi = 0; fi < fontsource.length; fi += 1) {
    const item = fontsource[fi];
    if (!item?.family) continue;
    if (dirKeys.has(familyKey(item.family))) continue;
    const category = CATEGORY_FS[item.category ?? ""] ?? "sans";
    const weights = item.weights?.length ? [...item.weights].sort((a, b) => a - b) : [400];
    const italic = Boolean(item.styles?.includes("italic"));
    const variable = Boolean(item.variable);
    const popularity = item.type === "other" ? 3000 + fi : 9000 + exclusiveIdx;
    exclusiveIdx += 1;
    exclusive.push([
      item.family,
      category,
      weights,
      italic,
      variable,
      popularity,
      [],
      item.license ?? "OFL-1.1",
    ]);
  }

  const otherCatalog = {
    updated,
    source: "api.fontsource.org/v1/fonts exclusive of Google metadata (live)",
    count: exclusive.length,
    families: exclusive,
  };

  const write = (name, data) => {
    const path = join(outDir, name);
    writeFileSync(path, `${JSON.stringify(data)}\n`);
    console.log(`wrote ${name}: count=${data.count}`);
  };

  write("google-directory.json", directory);
  write("google-catalog.json", googleCatalog);
  write("fontsource-other.json", otherCatalog);

  console.log(
    `OK — Google ${directory.count} + Fontsource exclusive ${otherCatalog.count} = ${directory.count + otherCatalog.count}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
