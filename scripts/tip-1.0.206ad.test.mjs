import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const downloadBar = readFileSync(
  join(root, "src/components/font-studio/download-bar.tsx"),
  "utf8",
);
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = readFileSync(join(root, "src/version.ts"), "utf8");

test("206ad keeps ProductVersion 1.0.206", () => {
  assert.equal(pkg.version, "1.0.207");
  assert.equal(tauri.version, "1.0.207");
  assert.match(version, /1\.0\.207/);
});

test("P0: Cancel is a click, not pointerdown", () => {
  assert.doesNotMatch(downloadBar, /onPointerDown|onMouseDown|isDocsCancelArmed\(\)/);
  assert.match(downloadBar, /fromDocsCancelChrome:\s*true/);
  assert.match(osActivate, /armDocsCancelFromChrome/);
});

test("P0: arm fires cancel IPC immediately; teardown still deferred (hang fix)", () => {
  const arm = osActivate.slice(
    osActivate.indexOf("function armDocsCancelFromChrome"),
    osActivate.indexOf("export function cancelDownloadQueue"),
  );
  assert.match(arm, /tauriInvoke\("cancel_documents_refresh"\)/);
  assert.match(arm, /setTimeout\(\s*\(\)\s*=>\s*finishDocsCancelTeardown\(\),\s*0\s*\)/);
  const ipcAt = arm.indexOf('tauriInvoke("cancel_documents_refresh")');
  const deferAt = arm.indexOf("setTimeout(() => finishDocsCancelTeardown()");
  assert.ok(ipcAt >= 0 && deferAt > ipcAt, "IPC before deferred teardown");
  assert.match(osActivate, /finishDocsCancelTeardown/);
});

test("P0: second arm is idempotent (no double schedule)", () => {
  const arm = osActivate.slice(
    osActivate.indexOf("function armDocsCancelFromChrome"),
    osActivate.indexOf("export function cancelDownloadQueue"),
  );
  assert.match(arm, /docsCancelTeardownScheduled/);
  assert.match(arm, /docsCancelIpcFired/);
  assert.match(arm, /return false/);
});

test("P0: success path never clears pending if cancel queued; callers re-check", () => {
  const sync = osActivate.slice(
    osActivate.indexOf("export async function syncDocumentsVfPolicy"),
    osActivate.indexOf("export async function syncManagedDocumentsRoot"),
  );
  assert.match(sync, /await Promise\.resolve\(\)/);
  assert.match(sync, /const cancelled = Boolean\(raw\.cancelled\)/);
  assert.doesNotMatch(
    sync,
    /cancelled\s*=\s*Boolean\(raw\.cancelled\)\s*\|\|\s*docsVfSyncCancelPending/,
  );
  assert.match(activateToggle, /peekDocsVfSyncCancelPending/);
});

test("P0: Rust cancelable purge + cancelled if flag after last purge", () => {
  assert.match(activateRs, /purge_redundant_statics_in_dir_cancelable/);
  assert.match(activateRs, /docs_vf_sync_execute_cancel_flag_after_last_purge_still_cancelled/);
  assert.match(
    activateRs,
    /loop_cancelled \|\| cancel\.load\(Ordering::SeqCst\)/,
  );
});

test("P1: no cancel-seq on the bar", () => {
  assert.doesNotMatch(downloadBar, /fm-cancel-seq=|aria-valuenow=\{getDocsCancelSeq|title=\{getDocsCancelSeq/);
});

test("206ac hang deferral kept", () => {
  assert.match(osActivate, /finishDocsCancelTeardown/);
  assert.match(osActivate, /Cancelling Documents refresh/);
  assert.match(activateRs, /pub async fn sync_documents_vf_policy/);
  assert.match(activateRs, /spawn_blocking/);
});

test("docs mark 206ad; no tip-install/pack", () => {
  assert.match(readme, /1\.0\.206ad/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206ad/);
  assert.match(bugs, /pointerdown|mouse|immediate.*IPC|cancelable/i);
  assert.match(bugs, /No tip-install\/pack|no tip-install/i);
});
