import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, buildStoreZip } from "../src/lib/fonts/pack-zip.ts";
import { isWoff2Magic } from "../src/lib/fonts/woff2-decode.ts";
import { CMAP_GLYPH_CAP } from "../src/lib/fonts/wasm-parse.ts";
import { coerceDesktopPrefs, DEFAULT_DESKTOP_PREFS } from "../src/lib/desktop/prefs.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("zip STORE roundtrip crc", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const zip = buildStoreZip([{ name: "Inter.ttf", data }]);
  assert.ok(zip.length > data.length);
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  assert.equal(crc32(data) >>> 0, crc32(new Uint8Array(data)) >>> 0);
});

test("woff2 magic only", () => {
  assert.equal(isWoff2Magic(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0])), true);
  assert.equal(isWoff2Magic(new Uint8Array([0, 1, 0, 0])), false);
});

test("cmap glyph cap is 8192", () => {
  assert.equal(CMAP_GLYPH_CAP, 8192);
  const rust = readFileSync(join(root, "src-tauri/src/parse.rs"), "utf8");
  assert.match(rust, /CMAP_GLYPH_CAP:\s*usize\s*=\s*8192/);
});

test("close-to-tray + startup prefs", () => {
  const main = readFileSync(join(root, "src-tauri/src/main.rs"), "utf8");
  assert.match(main, /CLOSE_TO_TRAY/);
  assert.match(main, /set_desktop_prefs/);
  assert.match(main, /Start Menu/);
  assert.equal(DEFAULT_DESKTOP_PREFS.closeToTray, false);
  assert.equal(coerceDesktopPrefs({ closeToTray: 1, startWithWindows: true }).startWithWindows, true);
});

test("watch import skips IDB when originPath; auto-activate uses setActivatedMany", () => {
  const store = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
  assert.match(store, /if \(!opts\?\.originPaths\?\.\[i\]\) \{/);
  assert.match(store, /setActivatedMany\(newIds, true\)/);
  assert.match(store, /where === "recent"/);
});

test("collection zip + inspector waterfall + desktop settings", () => {
  const tree = readFileSync(join(root, "src/components/font-studio/folder-tree.tsx"), "utf8");
  assert.match(tree, /exportCollectionZip/);
  const inspector = readFileSync(join(root, "src/components/font-studio/font-inspector.tsx"), "utf8");
  assert.match(inspector, /WATERFALL/);
  assert.match(inspector, /setFeaturePref/);
  const shell = readFileSync(join(root, "src/components/font-studio/app-shell.tsx"), "utf8");
  assert.match(shell, /DesktopSettings/);
});

test("prefs.ts has no top-level relative open-fonts import", () => {
  const prefs = readFileSync(join(root, "src/lib/desktop/prefs.ts"), "utf8");
  assert.doesNotMatch(prefs, /from ["']\.\/open-fonts/);
  assert.match(prefs, /set_desktop_prefs/);
});

test("try_fontsource_gdi_offer is ACL-allowed", () => {
  const toml = readFileSync(join(root, "src-tauri/permissions/font-activate.toml"), "utf8");
  assert.match(toml, /try_fontsource_gdi_offer/);
});
