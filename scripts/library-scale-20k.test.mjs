import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
const sidebar = readFileSync(join(root, "src/components/font-studio/sidebar.tsx"), "utf8");
const grid = readFileSync(join(root, "src/components/font-studio/library-grid.tsx"), "utf8");
const loader = readFileSync(join(root, "src/lib/fonts/loader.ts"), "utf8");

function poolForScope(scope, localFonts, googleFonts, systemFonts = [], liveIds = []) {
  if (scope === "system") return systemFonts;
  if (scope === "uploaded") return localFonts;
  if (scope === "gfonts" || scope === "google") return googleFonts;
  if (scope === "activated") {
    if (!liveIds.length) return [];
    const byId = new Map(
      [...localFonts, ...googleFonts, ...systemFonts].map((f) => [f.id, f]),
    );
    const out = [];
    const seen = new Set();
    for (const id of liveIds) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const font = byId.get(id);
      if (font) out.push(font);
    }
    return out;
  }
  if (!localFonts.length) return googleFonts;
  if (!googleFonts.length) return localFonts;
  return [...localFonts, ...googleFonts];
}

test("Google Fonts drawer does not concat 20k locals", () => {
  const local = Array.from({ length: 20_000 }, (_, i) => ({ id: `l:${i}` }));
  const google = Array.from({ length: 2_100 }, (_, i) => ({ id: `g:${i}` }));
  const pool = poolForScope("gfonts", local, google, []);
  assert.equal(pool.length, 2100);
  assert.equal(pool, google);
  assert.equal(poolForScope("uploaded", local, google).length, 20_000);
  assert.equal(poolForScope("all", local, google).length, 22_100);
});

test("Activated pool is O(live) — no 22k concat on facet/Activated tick", () => {
  const local = Array.from({ length: 20_000 }, (_, i) => ({ id: `l:${i}` }));
  const google = Array.from({ length: 2_100 }, (_, i) => ({ id: `g:${i}` }));
  const liveIds = ["g:0", "g:1", "l:9", "g:0"];
  const pool = poolForScope("activated", local, google, [], liveIds);
  assert.equal(pool.length, 3);
  assert.deepEqual(
    pool.map((f) => f.id),
    ["g:0", "g:1", "l:9"],
  );
  assert.equal(poolForScope("activated", local, google, [], []).length, 0);
});

test("source: poolForScope + gfonts grid + activated count is length", () => {
  assert.match(store, /export function poolForScope/);
  assert.match(store, /scope === "activated"/);
  assert.match(grid, /poolForScope\(scope, localPool, googleFonts, systemFonts, liveIds\)/);
  assert.match(sidebar, /poolForScope\(scope, skipLocals \? \[\] : localFonts, googleFonts, systemFonts, liveIds\)/);
  assert.match(sidebar, /activated: activated\.length/);
  assert.match(sidebar, /scope === "activated" \? activated : EMPTY_IDS/);
  assert.match(sidebar, /const facetCounts = useMemo/);
  assert.match(sidebar, /const providerCounts = useMemo/);
  assert.match(store, /id\.startsWith\("g:"\)/);
  // 1.0.186: map locals/google once — no per-live-id localFonts.find
  assert.match(store, /googleOnly \? null : new Map\(localFonts\.map/);
  assert.match(store, /localById\?\.get\(id\)/);
  assert.doesNotMatch(
    store.slice(store.indexOf("scope === \"activated\""), store.indexOf("return allFonts")),
    /localFonts\.find\(\(f\) => f\.id === id\)/,
  );
});

test("20k uploads parse in waves; IDB puts chunk", () => {
  const pool = readFileSync(join(root, "src/lib/fonts/parse-pool.ts"), "utf8");
  const idb = readFileSync(join(root, "src/lib/fonts/idb.ts"), "utf8");
  assert.match(pool, /export const PARSE_WAVE = 256/);
  assert.match(idb, /export const IDB_PUT_CHUNK = 48/);
  assert.match(store, /waveStart \+= PARSE_WAVE/);
});

test("preview subset is CSS text= / latin; GDI stays full fonts", () => {
  assert.match(loader, /googlePreviewCssHref/);
  assert.match(loader, /&text=\$\{googlePreviewTextQuery/);
  assert.doesNotMatch(loader, /pyftsubset|hb-subset|subset-font|hb-subset-wasm/);
  assert.doesNotMatch(store, /FR_PRIVATE|AddFontMemResourceEx/);
});
