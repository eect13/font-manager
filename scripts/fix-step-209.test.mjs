import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const store = readFileSync(new URL("src/lib/fonts/store.ts", root), "utf8");
const os = readFileSync(new URL("src/lib/fonts/os-activate.ts", root), "utf8");
const activateRs = readFileSync(new URL("src-tauri/src/activate.rs", root), "utf8");
const css = readFileSync(new URL("src/lib/fonts/css-export.ts", root), "utf8");
const grid = readFileSync(new URL("src/components/font-studio/library-grid.tsx", root), "utf8");

test("upload stays pending until Add, and does not restart Font Cache", () => {
  const imp = store.slice(store.indexOf("importFiles: async"), store.indexOf("importOriginPaths: async"));
  assert.match(imp, /withPending\(Array.from\(new Set\(\[\.\.\.s\.pendingActivate, \.\.\.keptIds\]\)\)\)/);
  assert.doesNotMatch(imp, /withActivated\(Array.from\(new Set\(\[\.\.\.s\.activated, \.\.\.waveIds\]\)\)\)/);
  assert.match(imp, /ids,/);
  assert.doesNotMatch(os, /flush_font_cache/);
  assert.match(os, /markLiveActivated\(savedIds\)/);
  assert.match(os, /clearPendingActivate\(failedIds\)/);
});

test("one local Activate does not also start the on-disk worker", () => {
  const single = os.slice(
    os.indexOf("export async function installFontOnSystem"),
    os.indexOf("export async function dropDownloadFamilies"),
  );
  const local = single.slice(single.indexOf("Already on this PC"));
  assert.doesNotMatch(local, /startActivateOnDisk/);
  assert.match(local, /installQueue\.push/);
  assert.match(local, /beginOwnedJob\("register"/);
});

test("register_font_path fails on Add=0 and binds the family", () => {
  const fn = activateRs.slice(
    activateRs.indexOf("pub async fn register_font_path"),
    activateRs.indexOf("pub async fn flush_font_cache"),
  );
  assert.match(fn, /family: Option<String>/);
  assert.match(fn, /if !register_path/);
  assert.match(fn, /AddFontResourceExW returned 0/);
  assert.match(fn, /winfont::bind/);
  const flush = activateRs.slice(
    activateRs.indexOf("pub async fn flush_font_cache"),
    activateRs.indexOf("fn unload_now("),
  );
  assert.match(flush, /spawn_blocking/);
  assert.doesNotMatch(flush, /pub fn flush_font_cache/);
});

test("popular sort does not collate, and the grid defers the list", () => {
  const fn = store.slice(store.indexOf("export function sortLibrary"), store.indexOf("export function collectionIsWatched"));
  const popular = fn.slice(fn.indexOf('sort === "popular"'), fn.indexOf("const desc"));
  assert.doesNotMatch(popular, /collator/);
  assert.match(popular, /a\.name < b\.name/);
  assert.match(grid, /useDeferredValue\(sortMode\)/);
  assert.match(grid, /useDeferredValue\(localFonts\)/);
});

test("local CSS export uses the file format and a distinct full name", () => {
  assert.match(css, /function faceFormat/);
  assert.match(css, /function cssFaceName/);
  assert.match(css, /format\("\$\{format\}"\)/);
  assert.doesNotMatch(css, /format\("woff2"\)/);
  assert.match(css, /fullName !== font\.family/);
});
