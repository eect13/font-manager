import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const os = readFileSync(new URL("src/lib/fonts/os-activate.ts", root), "utf8");
const store = readFileSync(new URL("src/lib/fonts/store.ts", root), "utf8");
const activateRs = readFileSync(new URL("src-tauri/src/activate.rs", root), "utf8");
const toggle = readFileSync(new URL("src/components/font-studio/activate-toggle.tsx", root), "utf8");

test("single-family unload and uninstall leave the UI thread", () => {
  assert.match(activateRs, /pub async fn unload_font_family/);
  assert.match(activateRs, /pub async fn uninstall_font_family/);
  const unload = activateRs.slice(
    activateRs.indexOf("pub async fn unload_font_family"),
    activateRs.indexOf("pub fn unload_font_families"),
  );
  const uninstall = activateRs.slice(
    activateRs.indexOf("pub async fn uninstall_font_family"),
    activateRs.indexOf("pub fn font_family_installed"),
  );
  assert.match(unload, /spawn_blocking/);
  assert.match(uninstall, /spawn_blocking/);
  assert.match(uninstall, /purge_family_files_result/);
  assert.doesNotMatch(unload, /Ok\(unload_now/);
});

test("live Deactivate does not restart Font Cache", () => {
  assert.match(activateRs, /fn plan_live_deactivate_font_cache_restart/);
  const body = activateRs.slice(
    activateRs.indexOf("pub fn plan_live_deactivate_font_cache_restart"),
    activateRs.indexOf("pub fn plan_live_deactivate_font_cache_restart") + 500,
  );
  assert.match(body, /false/);
  const unload = activateRs.slice(activateRs.indexOf("fn unload_now("), activateRs.indexOf("pub async fn unload_font_family"));
  assert.match(unload, /plan_live_deactivate_font_cache_restart/);
  assert.doesNotMatch(unload, /plan_font_cache_flush\(unloaded_paths/);
});

test("deactivate toasts share one id", () => {
  assert.match(os, /export const DEACTIVATE_TOAST_ID = "deactivate-job"/);
  assert.match(os, /id: DEACTIVATE_TOAST_ID/);
  assert.match(store, /id: DEACTIVATE_TOAST_ID/);
  assert.match(toggle, /id: DEACTIVATE_TOAST_ID/);
  assert.doesNotMatch(store, /unload-stuck-\$\{id\}/);
  assert.match(store, /PENDING_OFF_QUIET_MS/);
  assert.match(store, /Still unloading/);
});

test("folder delete and reset do not fire N parallel uninstalls", () => {
  const del = store.slice(
    store.indexOf("deleteCollection: (id, opts)"),
    store.indexOf("moveCollection: (id, parentId)"),
  );
  assert.match(del, /enqueueDiskDeletes\(doomed\)/);
  assert.match(del, /enqueueUninstalls\(doomed\)/);
  assert.doesNotMatch(del, /void removeUploadFromDisk/);
  assert.doesNotMatch(del, /void uninstallFontOnSystem/);
  const resetStart = store.indexOf("resetLibrary: async");
  const reset = store.slice(resetStart, resetStart + 900);
  assert.ok(reset.length > 40, "resetLibrary body");
  assert.match(reset, /enqueueUninstalls/);
  assert.doesNotMatch(reset, /void uninstallFontOnSystem/);
  assert.match(os, /export function enqueueDiskDeletes/);
  assert.match(os, /export function enqueueUninstalls/);
  assert.match(os, /function kickRemove/);
  assert.match(os, /id: "recycle-batch"/);
});

test("remove poll does not reset an Activate ready batch", () => {
  const poll = os.slice(os.indexOf("function startGooglePoll"), os.indexOf("function paint"));
  assert.match(poll, /kind !== "remove"/);
  assert.match(poll, /resetReadyBatching/);
});
