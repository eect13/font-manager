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
const desktopSettings = readFileSync(
  join(root, "src/components/font-studio/desktop-settings.tsx"),
  "utf8",
);
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = readFileSync(join(root, "src/version.ts"), "utf8");

test("206ac keeps ProductVersion 1.0.206", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.equal(tauri.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("P0: docs Cancel defers teardown off Invoke stack (no sync hang)", () => {
  assert.match(osActivate, /finishDocsCancelTeardown/);
  assert.match(osActivate, /setTimeout\(\s*\(\)\s*=>\s*finishDocsCancelTeardown\(\),\s*0\s*\)/);
  assert.match(osActivate, /armDocsCancelFromChrome|docsVfSyncCancelPending = true/);
  assert.match(osActivate, /Cancelling Documents refresh/);
  // 206ad: cancel IPC fires immediately on arm (beat purge); only bar teardown is deferred.
  const arm = osActivate.slice(
    osActivate.indexOf("function armDocsCancelFromChrome"),
    osActivate.indexOf("export function cancelDownloadQueue"),
  );
  assert.match(arm, /tauriInvoke\("cancel_google_downloads"\)/);
  assert.match(arm, /setTimeout\(\s*\(\)\s*=>\s*finishDocsCancelTeardown/);
});

test("P0: stuck Refreshing toast replaced on cancel; cancelled toast after Rust", () => {
  assert.match(osActivate, /Cancelling Documents refresh/);
  assert.match(osActivate, /replaceDocsRefreshingToastWithCancelling|toast\.dismiss\(DOCS_REFRESH_TOAST_ID\)/);
  assert.match(activateToggle, /Documents refresh cancelled/);
  assert.match(desktopSettings, /Documents refresh cancelled/);
  // Toast decision before rescan (cancelled branch precedes syncManagedDocumentsRoot in cancelled path)
  const refreshStart = activateToggle.indexOf("const result = await syncDocumentsVfPolicy");
  assert.ok(refreshStart >= 0);
  const toggle = activateToggle.slice(refreshStart, refreshStart + 2500);
  const cancelledToast = toggle.indexOf('"Documents refresh cancelled"');
  const cancelledCheck = toggle.indexOf("result.cancelled");
  assert.ok(cancelledCheck >= 0 && cancelledToast > cancelledCheck);
  // Cancelled toast appears before the success "Documents refreshed" string.
  const successToast = toggle.indexOf("Documents refreshed —");
  assert.ok(successToast < 0 || successToast > cancelledToast);
  assert.match(toggle, /best-effort after cancel|Documents refresh cancelled/);
});

test("P0: late-cancel honesty; no soft-lie OR", () => {
  const sync = osActivate.slice(
    osActivate.indexOf("export async function syncDocumentsVfPolicy"),
    osActivate.indexOf("export async function syncManagedDocumentsRoot"),
  );
  assert.match(sync, /const cancelled = Boolean\(raw\.cancelled\)/);
  assert.doesNotMatch(
    sync,
    /cancelled\s*=\s*Boolean\(raw\.cancelled\)\s*\|\|\s*docsVfSyncCancelPending/,
  );
  assert.match(activateToggle, /Cancel arrived after Documents refresh finished/);
});

test("P0: Rust cancel IPC is flag-only; work returns cancelled; skip emit after cancel", () => {
  assert.match(activateRs, /pub async fn cancel_google_downloads/);
  assert.match(activateRs, /state\.cancel\.store\(true/);
  assert.match(activateRs, /docs_vf_sync_execute/);
  assert.match(activateRs, /after cancel, skip progress emits|skip progress emits/);
  // Document assert: cancel command does not spawn_blocking (completes while work runs)
  const cancelCmd = activateRs.slice(
    activateRs.indexOf("pub async fn cancel_google_downloads"),
    activateRs.indexOf("pub async fn cancel_google_downloads") + 800,
  );
  assert.doesNotMatch(cancelCmd, /spawn_blocking/);
});

test("P2: cancel-seq exposed via data-fm-cancel-seq (206af: no aria-valuenow Name steal)", () => {
  assert.match(osActivate, /data-fm-cancel-seq/);
  assert.match(downloadBar, /data-fm-cancel-seq/);
  // 206af removed mid-job aria-valuenow/title from Cancel button (UIA FromPoint blind).
  assert.doesNotMatch(downloadBar, /aria-valuenow=\{getDocsCancelSeq/);
});

test("206ab keepers still present", () => {
  assert.match(osActivate, /fromDocsCancelChrome/);
  assert.match(downloadBar, /fromDocsCancelChrome:\s*true/);
  assert.match(activateRs, /pub async fn sync_documents_vf_policy/);
  assert.match(activateRs, /spawn_blocking/);
});

test("docs mark 206ac; no tip-install/pack", () => {
  assert.match(readme, /1\.0\.206ac/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206ac/);
  assert.match(bugs, /Invoke|hang|Cancelling|setTimeout|Refreshing/i);
  assert.match(bugs, /No tip-install\/pack|no tip-install/i);
});
