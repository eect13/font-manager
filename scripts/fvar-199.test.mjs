import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FVAR_UNITS, formatFvar, snapFvar, instanceMatches } from "../src/lib/fonts/axes.ts";
import { countSearchPresets, fontMatchesSearch, parseSearchQuery } from "../src/lib/fonts/metrics.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("fvar snap is 16.16 Fixed, not raw f32 dust", () => {
  assert.equal(FVAR_UNITS, 65536);
  assert.equal(snapFvar(100), 100);
  assert.equal(snapFvar(99.99998474121094), 100);
  assert.equal(snapFvar(400.0000305175781), 400);
  assert.equal(snapFvar(14.0), 14);
  assert.ok(Math.abs(snapFvar(8.12) - 8.12) < 0.001);
  assert.notEqual(snapFvar(8.12), 8);
  assert.equal(formatFvar(99.99998474121094, 1), "100");
  assert.equal(formatFvar(8.12, 0.01), "8.12");
  assert.equal(
    instanceMatches({ name: "Regular", coords: { wght: 400 } }, { wght: 400.2 }),
    true,
  );
  assert.equal(
    instanceMatches({ name: "Caption", coords: { opsz: 8 } }, { opsz: 8.4 }),
    false,
  );
});

test("SuperSearch counts hide empty xh until OS/2", () => {
  const catalog = {
    id: "g:Inter",
    family: "Inter",
    source: "google",
    category: "sans",
    weights: [100, 400, 900],
    italic: false,
    variable: false,
    catalogVariable: true,
    tags: [],
    popularity: 1,
    license: "free",
  };
  const counts = countSearchPresets([catalog], {});
  assert.equal(counts["xh-high"], 0);
  assert.equal(counts["ctr-high"], 0);
  assert.ok((counts.heavy ?? 0) > 0);
  assert.ok((counts.variable ?? 0) > 0);
  assert.equal(fontMatchesSearch(catalog, parseSearchQuery("xh:0.52-1"), {}), false);
});

test("inspector overlays — left sidebar does not reflow", () => {
  const inspector = readFileSync(join(root, "src/components/font-studio/font-inspector.tsx"), "utf8");
  const shell = readFileSync(join(root, "src/components/font-studio/app-shell.tsx"), "utf8");
  assert.match(inspector, /fixed inset-y-0 right-0 z-30/);
  assert.match(inspector, /md:static md:inset-auto md:z-auto md:w-inspector md:shrink-0/);
  assert.doesNotMatch(inspector, /shrink-0 flex-col overflow-hidden border-l[\s\S]*w-\[min\(100%,24rem\)\]/);
  assert.match(shell, /relative flex min-h-0 flex-1 overflow-hidden/);
});

test("20k import waves + IDB chunks; no harfbuzz-wasm", () => {
  const store = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
  const pool = readFileSync(join(root, "src/lib/fonts/parse-pool.ts"), "utf8");
  const idb = readFileSync(join(root, "src/lib/fonts/idb.ts"), "utf8");
  assert.match(pool, /export const PARSE_WAVE = 256/);
  assert.match(idb, /export const IDB_PUT_CHUNK = 48/);
  assert.match(store, /PARSE_WAVE/);
  assert.match(store, /waveStart \+= PARSE_WAVE/);
  const rust = readFileSync(join(root, "src-tauri/src/parse.rs"), "utf8");
  assert.match(rust, /fn snap_fvar/);
  assert.match(readFileSync(join(root, "src/lib/fonts/wasm-parse.ts"), "utf8"), /harfbuzz-wasm/);
  assert.doesNotMatch(store, /harfbuzz/);
});

test("dynamic SuperSearch chips use countSearchPresets", () => {
  const chips = readFileSync(join(root, "src/components/font-studio/search-chips.tsx"), "utf8");
  assert.match(chips, /countSearchPresets/);
  assert.match(chips, /counts\[chip\.id\]/);
});

test("countSearchPresets is one-pass 20k-safe", () => {
  const fonts = Array.from({ length: 20_000 }, (_, i) => ({
    id: `l:${i}`,
    family: `Fam${i}`,
    source: "local",
    category: "sans",
    weights: [400, 700],
    italic: i % 7 === 0,
    variable: false,
    catalogVariable: i % 11 === 0,
    tags: [],
    popularity: 1,
    license: "free",
  }));
  const t0 = Date.now();
  const counts = countSearchPresets(fonts, {});
  assert.ok(Date.now() - t0 < 800, `countSearchPresets 20k took ${Date.now() - t0}ms`);
  assert.equal(counts.italic, Math.ceil(20_000 / 7));
  assert.ok((counts.variable ?? 0) > 0);
  assert.equal(counts["xh-high"], 0);
  assert.ok((counts.heavy ?? 0) > 0);
});
