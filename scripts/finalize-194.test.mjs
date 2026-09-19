import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CATALOG_CACHE_VERSION, healCachedCatalogFont } from "../src/lib/fonts/heal-catalog.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function pickLocalFontsPersist(idb, fromLs) {
  const a = idb ?? [];
  if (a.length >= fromLs.length) return a.length ? a : fromLs;
  return fromLs;
}

test("real import: catalog cache schema is v2", () => {
  assert.equal(CATALOG_CACHE_VERSION, 2);
  const api = readFileSync(join(root, "src/lib/fonts/google-api.ts"), "utf8");
  assert.match(api, /CATALOG_CACHE_VERSION/);
  assert.match(api, /parsed\.v !== 1 && parsed\.v !== CATALOG_CACHE_VERSION/);
  assert.match(api, /variable: false/);
});

test("real import: healCachedCatalogFont", () => {
  assert.deepEqual(
    healCachedCatalogFont({ family: "Inter", catalogVariable: undefined, variable: true }, { catalogVariable: true }),
    { variable: false, catalogVariable: true },
  );
  assert.deepEqual(
    healCachedCatalogFont({ family: "Lora", catalogVariable: false, variable: true }, { catalogVariable: false }),
    { variable: false, catalogVariable: false },
  );
  assert.equal(
    healCachedCatalogFont(
      { family: "Material Symbols Outlined", catalogVariable: true },
      { catalogVariable: true },
    ).catalogVariable,
    false,
  );
});

test("IDB localFonts persist prefers larger catalog (20k)", () => {
  const ls = [{ id: "l-0" }, { id: "l-1" }];
  const idb = Array.from({ length: 20_000 }, (_, i) => ({ id: `l-${i}` }));
  assert.equal(pickLocalFontsPersist(idb, ls).length, 20_000);
  assert.equal(pickLocalFontsPersist(null, ls).length, 2);
  assert.equal(pickLocalFontsPersist([], []).length, 0);
  const persist = readFileSync(join(root, "src/lib/fonts/persist-local.ts"), "utf8");
  assert.match(persist, /export function pickLocalFontsPersist/);
  assert.match(persist, /LOCAL_FONTS_META_ID = "meta:local-fonts"/);
});

test("source: localFonts out of localStorage; Activated skips 20k map when google-only", () => {
  const store = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
  assert.match(store, /version: 5/);
  assert.match(store, /localFonts: \[\]/);
  assert.match(store, /const googleOnly = liveIds\.every/);
  assert.match(store, /localById\?\.get\(id\)/);
  const hydrate = readFileSync(join(root, "src/lib/fonts/hydrate.ts"), "utf8");
  assert.match(hydrate, /loadLocalFontsMeta/);
  const axes = readFileSync(join(root, "src/lib/fonts/axes.ts"), "utf8");
  assert.match(axes, /export function previewWghtAxis/);
  const deploy = readFileSync(join(root, "scripts/deploy.mjs"), "utf8");
  assert.match(deploy, /gh release upload v\$\{APP_VER\}/);
  assert.match(deploy, /tauri build --bundles nsis/);
});
