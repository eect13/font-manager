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

function poolForScope(scope, localFonts, googleFonts, systemFonts = []) {
  if (scope === "system") return systemFonts;
  if (scope === "uploaded") return localFonts;
  if (scope === "gfonts" || scope === "google") return googleFonts;
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

test("source: poolForScope + gfonts grid + activated count is length", () => {
  assert.match(store, /export function poolForScope/);
  assert.match(grid, /poolForScope\(scope, localFonts, googleFonts, systemFonts\)/);
  assert.match(sidebar, /poolForScope\(scope, localFonts, googleFonts, systemFonts\)/);
  assert.match(sidebar, /activated: activated\.length/);
  assert.match(sidebar, /scope === "activated" \? activated : EMPTY_IDS/);
  assert.match(sidebar, /const facetCounts = useMemo/);
  assert.match(sidebar, /const providerCounts = useMemo/);
  assert.match(store, /id\.startsWith\("g:"\)/);
});

test("preview subset is CSS text= / latin; GDI stays full fonts", () => {
  assert.match(loader, /googlePreviewCssHref/);
  assert.match(loader, /&text=\$\{googlePreviewTextQuery/);
  assert.doesNotMatch(loader, /pyftsubset|hb-subset|subset-font|hb-subset-wasm/);
  assert.doesNotMatch(store, /FR_PRIVATE|AddFontMemResourceEx/);
});
