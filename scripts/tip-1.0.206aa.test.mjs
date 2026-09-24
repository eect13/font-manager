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
const appShell = readFileSync(
  join(root, "src/components/font-studio/app-shell.tsx"),
  "utf8",
);
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const desktopSettings = readFileSync(
  join(root, "src/components/font-studio/desktop-settings.tsx"),
  "utf8",
);
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = readFileSync(join(root, "src/version.ts"), "utf8");

test("206aa keeps ProductVersion 1.0.206", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.equal(tauri.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("P0-1: sync_documents_vf_policy and cancel_google_downloads are async commands", () => {
  assert.match(
    activateRs,
    /pub async fn sync_documents_vf_policy\s*\(\s*app:\s*AppHandle\s*\)/,
  );
  assert.match(activateRs, /tauri::async_runtime::spawn_blocking/);
  assert.match(activateRs, /pub async fn cancel_google_downloads\s*\(/);
  // Must not block main thread via sync cmd + rx.recv()
  assert.doesNotMatch(
    activateRs.slice(
      activateRs.indexOf("pub async fn sync_documents_vf_policy"),
      activateRs.indexOf("fn run_docs_vf_sync_purge_loop"),
    ),
    /rx\.recv\(\)|std::sync::mpsc/,
  );
});

test("P0-1/P1-5: real purge loop shared by production + unit test (no sim copy)", () => {
  assert.match(activateRs, /fn run_docs_vf_sync_purge_loop/);
  assert.doesNotMatch(activateRs, /docs_vf_sync_loop_sim/);
  assert.match(activateRs, /docs_vf_sync_loop_stops_before_further_purges_when_cancelled/);
  const work = activateRs.slice(
    activateRs.indexOf("fn sync_documents_vf_policy_work"),
    activateRs.indexOf("fn finish_docs_vf_sync"),
  );
  // 206ab: work calls docs_vf_sync_execute (which uses the shared purge loop).
  assert.match(activateRs, /fn docs_vf_sync_execute/);
  assert.match(work, /docs_vf_sync_execute|run_docs_vf_sync_purge_loop/);
  assert.match(work, /purge_redundant_statics_in_dir/);
  assert.match(work, /scan_cancelled/);
});

test("P0-2: cancelled toast requires raw.cancelled; late-cancel copy exists; no soft-lie OR", () => {
  const sync = osActivate.slice(
    osActivate.indexOf("export async function syncDocumentsVfPolicy"),
    osActivate.indexOf("export async function syncManagedDocumentsRoot"),
  );
  assert.doesNotMatch(
    sync,
    /cancelled\s*=\s*Boolean\(raw\.cancelled\)\s*\|\|\s*docsVfSyncCancelPending/,
  );
  assert.match(sync, /const cancelled = Boolean\(raw\.cancelled\)/);
  assert.match(sync, /cancelArrivedLate/);
  assert.match(activateToggle, /Cancel arrived after Documents refresh finished/);
  assert.match(desktopSettings, /Cancel arrived after Documents refresh finished/);
  assert.match(activateToggle, /no redundant statics removed/);
  // cancelled toast only on result.cancelled branch
  assert.match(activateToggle, /Documents refresh cancelled/);
  const cancelledAt = activateToggle.indexOf("Documents refresh cancelled");
  const lateAt = activateToggle.indexOf("Cancel arrived after Documents refresh finished");
  const successAt = activateToggle.indexOf("Documents refreshed —");
  assert.ok(cancelledAt > 0 && lateAt > cancelledAt && successAt > lateAt);
});

test("P1-3: docs cancel IPC is fire-and-forget (accurate; async cmds free main thread)", () => {
  const cancelFn = osActivate.slice(
    osActivate.indexOf("export function cancelDownloadQueue"),
    osActivate.indexOf("export function pauseDownloadQueue"),
  );
  assert.match(cancelFn, /wasDocsVfSync/);
  assert.match(cancelFn, /tauriInvoke\("cancel_google_downloads"\)/);
  // Must not claim a blocking await on the click path
  assert.doesNotMatch(
    cancelFn,
    /await tauriInvoke\("cancel_google_downloads"\)/,
  );
  // 206ac: docs path defers teardown via setTimeout; IPC is still non-blocking.
  assert.match(
    osActivate,
    /fire-and-forget|not queued behind|finishDocsCancelTeardown|setTimeout\(\s*\(\)\s*=>\s*finishDocsCancelTeardown/i,
  );
});

test("P1-4: docs Cancel onClick only; cancelDownloadQueue docs-idempotent", () => {
  assert.match(downloadBar, /docsChrome \? \(/);
  assert.match(downloadBar, /type="button"/);
  assert.match(downloadBar, /key="activate-bar-cancel"/);
  const native = downloadBar.match(/docsChrome \? \([\s\S]*?<button[\s\S]*?<\/button>/);
  assert.ok(native, "docsChrome native button");
  assert.match(native[0], /onClick/);
  // 206ad: pointerdown is required for mouse Gate D (idempotent with click).
  assert.match(native[0], /onPointerDown/);
  assert.doesNotMatch(native[0], /active:not-disabled:scale/);
  assert.match(native[0], /cancelDownloadQueue\(/);
  const cancelFn = osActivate.slice(
    osActivate.indexOf("export function cancelDownloadQueue"),
    osActivate.indexOf("export function pauseDownloadQueue"),
  );
  // Guard conditioned on job state (idle + pending).
  assert.match(
    cancelFn,
    /!job\.running && !job\.paused && docsVfSyncCancelPending/,
  );
  // 206ad: also idempotent when already armed (pending + teardownScheduled).
  assert.match(
    cancelFn,
    /wasDocsVfSync && docsVfSyncCancelPending && docsCancelTeardownScheduled/,
  );
  assert.match(cancelFn, /armDocsCancelFromChrome\(\)/);
});

test("nit: finally clears docsVfSyncCancelPending in both Refresh callers", () => {
  assert.match(activateToggle, /clearDocsVfSyncCancelPending\(\)/);
  assert.match(desktopSettings, /clearDocsVfSyncCancelPending\(\)/);
  assert.match(osActivate, /export function clearDocsVfSyncCancelPending/);
  for (const [label, src] of [
    ["activate-toggle", activateToggle],
    ["desktop-settings", desktopSettings],
  ]) {
    const finallyAt = src.indexOf("finally {");
    assert.ok(finallyAt > 0, `${label} has finally`);
    const clearAt = src.indexOf("clearDocsVfSyncCancelPending()", finallyAt);
    assert.ok(clearAt > finallyAt, `${label} clears pending in finally`);
  }
});

test("nit: spawn_blocking join error resets running via finish_docs_vf_sync", () => {
  const syncCmd = activateRs.slice(
    activateRs.indexOf("pub async fn sync_documents_vf_policy"),
    activateRs.indexOf("fn run_docs_vf_sync_purge_loop"),
  );
  assert.match(syncCmd, /spawn_blocking/);
  assert.match(syncCmd, /finish_docs_vf_sync/);
  assert.match(syncCmd, /join failed|worker join/i);
  assert.match(syncCmd, /app_join|app\.clone\(\)/);
});

test("app-shell uses inert without aria-hidden during docs (GetClickablePoint)", () => {
  assert.match(appShell, /inert=\{hideLibraryA11y/);
  assert.doesNotMatch(appShell, /aria-hidden=\{hideLibraryA11y/);
  const barAt = appShell.indexOf("<DownloadBar");
  const inertAt = appShell.indexOf("data-fm-library-inert");
  assert.ok(barAt >= 0 && inertAt > barAt);
});

test("docs mark 206aa amend; no tip-install/pack", () => {
  assert.match(readme, /1\.0\.206aa/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206aa/);
  assert.match(
    bugs,
    /async|spawn_blocking|main.thread|late-cancel|cancelArrivedLate|onClick only|run_docs_vf_sync_purge_loop/i,
  );
  assert.match(readme, /async|spawn_blocking|late-cancel|main thread/i);
  assert.match(bugs, /No tip-install\/pack/);
  assert.match(readme, /No tip-install/);
  assert.match(readme, /1\.0\.206z/);
});
