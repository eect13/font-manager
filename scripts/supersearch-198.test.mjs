import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  fontMatchesSearch,
  metricsFromTables,
  parseSearchQuery,
  toggleSearchPreset,
  queryHasToken,
  SEARCH_PRESETS,
} from "../src/lib/fonts/metrics.ts";
import { parseCollectionSync } from "../src/lib/fonts/collection-sync.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function rec(partial = {}) {
  return {
    id: "g:Test",
    family: "Test",
    source: "google",
    category: "sans",
    weights: [400],
    italic: false,
    variable: false,
    tags: [],
    popularity: 1,
    license: "free",
    ...partial,
  };
}

test("parseSearchQuery tokens: ranges, named, axis tags", () => {
  const clauses = parseSearchQuery("xh:0.52-1 contrast:high weight:700-1000 wght:100-900 opsz:8-14 axis:wdth=75-100 variable Inter");
  const kinds = clauses.map((c) => c.kind);
  assert.deepEqual(kinds, ["range", "range", "range", "axis", "axis", "axis", "flag", "hay"]);
  const xh = clauses.find((c) => c.kind === "range" && c.field === "xh");
  assert.equal(xh.min, 0.52);
  assert.equal(xh.max, 1);
  const ctr = clauses.find((c) => c.kind === "range" && c.field === "contrast");
  assert.ok(ctr.min >= 0.65);
  const opsz = clauses.find((c) => c.kind === "axis" && c.tag === "opsz");
  assert.equal(opsz.min, 8);
  assert.equal(opsz.max, 14);
  const wdth = clauses.find((c) => c.kind === "axis" && c.tag === "wdth");
  assert.equal(wdth.min, 75);
  assert.equal(wdth.max, 100);
});

test("xh and contrast fail closed when OS/2 unread", () => {
  const catalog = rec({ catalogVariable: true, weights: [100, 400, 900] });
  assert.equal(fontMatchesSearch(catalog, parseSearchQuery("xh:0.52-1"), {}), false);
  assert.equal(fontMatchesSearch(catalog, parseSearchQuery("contrast:high"), {}), false);
  assert.equal(fontMatchesSearch(catalog, parseSearchQuery("weight:700-1000"), {}), true);
  assert.equal(fontMatchesSearch(catalog, parseSearchQuery("wght:800-900"), {}), true);
  assert.equal(fontMatchesSearch(catalog, parseSearchQuery("opsz:8-14"), {}), false);
});

test("measured xh/contrast match; dummy PANOSE is not contrast", () => {
  const measured = rec({
    metrics: metricsFromTables({
      upem: 1000,
      weightClass: 400,
      widthClass: 5,
      xHeight: 540,
      capHeight: 700,
      panose: [2, 11, 6, 4, 8, 2, 2, 2, 2, 4],
    }),
  });
  assert.equal(measured.metrics.xh, 0.54);
  assert.ok(measured.metrics.contrast != null && measured.metrics.contrast >= 0.65);
  assert.equal(fontMatchesSearch(measured, parseSearchQuery("xh:0.52-1"), {}), true);
  assert.equal(fontMatchesSearch(measured, parseSearchQuery("xh:0-0.45"), {}), false);
  assert.equal(fontMatchesSearch(measured, parseSearchQuery("contrast:high"), {}), true);
  const dummy = rec({
    metrics: metricsFromTables({
      upem: 1000,
      weightClass: 400,
      widthClass: 5,
      panose: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    }),
  });
  assert.equal(dummy.metrics.contrast, undefined);
  assert.equal(fontMatchesSearch(dummy, parseSearchQuery("contrast:low"), {}), false);
});

test("variable axis range overlap is honest (not any-VF)", () => {
  const vf = rec({
    variable: true,
    catalogVariable: true,
    axes: [
      { tag: "wght", name: "Weight", min: 200, max: 700, def: 400 },
      { tag: "opsz", name: "Optical size", min: 8, max: 144, def: 14 },
    ],
  });
  assert.equal(fontMatchesSearch(vf, parseSearchQuery("wght:100-150"), {}), false);
  assert.equal(fontMatchesSearch(vf, parseSearchQuery("wght:600-900"), {}), true);
  assert.equal(fontMatchesSearch(vf, parseSearchQuery("opsz:8-14"), {}), true);
  assert.equal(fontMatchesSearch(vf, parseSearchQuery("opsz:200-400"), {}), false);
  assert.equal(fontMatchesSearch(vf, parseSearchQuery("weight:100"), {}), false);
  const statics = rec({ variable: false, catalogVariable: false, weights: [400] });
  assert.equal(fontMatchesSearch(statics, parseSearchQuery("weight:100"), {}), false);
  assert.equal(fontMatchesSearch(statics, parseSearchQuery("weight:400"), {}), true);
});

test("toggleSearchPreset replaces sibling chips", () => {
  let q = toggleSearchPreset("", "xh:0.52-1");
  assert.equal(queryHasToken(q, "xh:0.52-1"), true);
  q = toggleSearchPreset(q, "xh:0-0.45");
  assert.equal(queryHasToken(q, "xh:0.52-1"), false);
  assert.equal(queryHasToken(q, "xh:0-0.45"), true);
  q = toggleSearchPreset(q, "xh:0-0.45");
  assert.equal(q, "");
  assert.ok(SEARCH_PRESETS.some((p) => p.token === "opsz:6-18"));
  assert.ok(SEARCH_PRESETS.some((p) => p.token === "opsz:36-144"));
});

test("collection JSON v1 parse rejects junk and keeps families", () => {
  assert.equal(parseCollectionSync({ v: 2, app: "font-manager", collections: [] }), null);
  assert.equal(parseCollectionSync({ hello: true }), null);
  const ok = parseCollectionSync({
    v: 1,
    app: "font-manager",
    exportedAt: 1,
    collections: [{ name: "Editorial", families: ["Playfair Display", 7, ""] }],
    favorites: ["Inter"],
  });
  assert.ok(ok);
  assert.deepEqual(ok.collections[0].families, ["Playfair Display"]);
  assert.deepEqual(ok.favorites, ["Inter"]);
});

test("store SuperSearch wiring + import metrics + native OS/2", () => {
  const store = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
  assert.match(store, /return fontMatchesSearch\(font, parseSearchQuery\(query\), customTags\)/);
  assert.match(store, /metrics: parsed\.metrics/);
  assert.match(store, /patchFontMetrics/);
  assert.doesNotMatch(store, /font\.variable && !Number\.isNaN\(w\)/);
  const rust = readFileSync(join(root, "src-tauri/src/parse.rs"), "utf8");
  assert.match(rust, /fn metrics_from_face/);
  assert.match(rust, /fn panose_from_face/);
  assert.match(rust, /weight_class: face\.weight\(\)\.to_number\(\)/);
  const chips = readFileSync(join(root, "src/components/font-studio/search-chips.tsx"), "utf8");
  assert.match(chips, /SEARCH_PRESETS/);
  const inspector = readFileSync(join(root, "src/components/font-studio/font-inspector.tsx"), "utf8");
  assert.match(inspector, /SuperSearch/);
  assert.match(inspector, /patchFontMetrics/);
  const tree = readFileSync(join(root, "src/components/font-studio/folder-tree.tsx"), "utf8");
  assert.match(tree, /exportCollectionJson/);
  assert.match(tree, /importCollectionJson/);
  const version = readFileSync(join(root, "src/version.ts"), "utf8");
  assert.match(version, /1\.0\.20[0-9]/);
});
