import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const store = readFileSync(new URL("src/lib/fonts/store.ts", root), "utf8");
const os = readFileSync(new URL("src/lib/fonts/os-activate.ts", root), "utf8");
const bar = readFileSync(new URL("src/components/font-studio/download-bar.tsx", root), "utf8");
const fallback = readFileSync(new URL("src/lib/fonts/fallback.ts", root), "utf8");
const loader = readFileSync(new URL("src/lib/fonts/loader.ts", root), "utf8");
const parseRs = readFileSync(new URL("src-tauri/src/parse.rs", root), "utf8");
const activateRs = readFileSync(new URL("src-tauri/src/activate.rs", root), "utf8");

test("recent sort does not break ties with the alphabet", () => {
  const fn = store.slice(store.indexOf("export function sortLibrary"), store.indexOf("export function collectionIsWatched"));
  assert.match(fn, /b\.at - a\.at \|\| a\.index - b\.index/);
  const recent = fn.slice(fn.indexOf('sort === "recent"'), fn.indexOf('sort === "popular"'));
  assert.doesNotMatch(recent, /collator/);
});

test("local files preview under a private CSS family", () => {
  assert.match(fallback, /source === "local" && font\.id/);
  assert.match(fallback, /return `fm-\$\{font\.id\}`/);
  assert.match(loader, /previewFaceName\(font\)/);
});

test("local Activate is not labelled Downloading", () => {
  const local = os.slice(os.indexOf("if (local.length)"), os.indexOf("export async function openActivatedFolder"));
  assert.match(local, /beginOwnedJob\("register"/);
  assert.doesNotMatch(local, /beginOwnedJob\("download"/);
  const pump = os.slice(os.indexOf("async function pumpInstall"), os.indexOf("function kickInstall"));
  assert.match(pump, /localFile && owner !== "download" \? "register"/);
  assert.match(bar, /Activating \$\{processed/);
});

test("folder index and path register leave the UI thread", () => {
  assert.match(parseRs, /pub async fn index_font_paths/);
  assert.match(parseRs, /spawn_blocking/);
  assert.match(parseRs, /modified_ms/);
  assert.match(activateRs, /pub async fn register_font_path/);
  assert.match(activateRs, /spawn_blocking/);
});
