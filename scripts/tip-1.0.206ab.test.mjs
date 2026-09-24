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
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = readFileSync(join(root, "src/version.ts"), "utf8");

test("206ab keeps ProductVersion 1.0.206", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.equal(tauri.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("P0: cancelDownloadQueue docs path bumps data-fm-cancel-seq", () => {
  assert.match(osActivate, /data-fm-cancel-seq/);
  assert.match(osActivate, /bumpDocsCancelSeqInDom|docsCancelSeq/);
  assert.match(osActivate, /fromDocsCancelChrome/);
  assert.match(osActivate, /docsCancelChromePresented/);
  assert.match(osActivate, /setDocsCancelChromePresented/);
  const cancelFn = osActivate.slice(
    osActivate.indexOf("export function cancelDownloadQueue"),
    osActivate.indexOf("export function pauseDownloadQueue"),
  );
  assert.match(cancelFn, /fromDocsCancelChrome|docsCancelChromePresented/);
  assert.match(cancelFn, /bumpDocsCancelSeqInDom/);
  // 206ad: pending set inside armDocsCancelFromChrome (called from docs path).
  assert.match(cancelFn, /armDocsCancelFromChrome\(\)/);
  assert.match(osActivate, /docsVfSyncCancelPending = true/);
});

test("P0: bar docs Cancel passes fromDocsCancelChrome + native InvokePattern button", () => {
  assert.match(downloadBar, /fromDocsCancelChrome:\s*true/);
  assert.match(downloadBar, /setDocsCancelChromePresented/);
  assert.match(downloadBar, /type="button"/);
  assert.match(downloadBar, /role="button"/);
  assert.match(downloadBar, /data-fm-cancel-seq/);
  assert.match(downloadBar, /onKeyDown/);
  // Cancel rendered before Pause when docsChrome (FindFirst walks early)
  const docsBtn = downloadBar.indexOf("fromDocsCancelChrome: true");
  const pauseAt = downloadBar.indexOf('data-testid="activate-bar-pause"');
  assert.ok(docsBtn > 0 && pauseAt > docsBtn, "docs Cancel before Pause in source");
});

test("P0: late-cancel honesty kept; no soft-lie OR", () => {
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
  assert.match(activateToggle, /Documents refresh cancelled/);
});

test("P0: Rust docs_vf_sync_execute returns cancelled; work uses it", () => {
  assert.match(activateRs, /fn docs_vf_sync_execute/);
  assert.match(activateRs, /docs_vf_sync_execute_mid_purge_returns_cancelled_true/);
  assert.match(activateRs, /docs_vf_sync_execute_scan_cancel_skips_all_purges/);
  assert.match(activateRs, /fn sync_documents_vf_policy_work/);
  const work = activateRs.slice(
    activateRs.indexOf("fn sync_documents_vf_policy_work"),
    activateRs.indexOf("fn finish_docs_vf_sync"),
  );
  assert.match(work, /docs_vf_sync_execute/);
});

test("P0 FindFirst: header+nav inert during docs; chrome outside library; no aria-hidden library", () => {
  assert.match(appShell, /inert=\{hideLibraryA11y/);
  // header and bottom nav also inert
  const headerBlock = appShell.slice(
    appShell.indexOf("<header"),
    appShell.indexOf("</header>") + 10,
  );
  assert.match(headerBlock, /inert=\{hideLibraryA11y/);
  assert.match(appShell, /data-fm-shell-chrome/);
  assert.match(appShell, /Documents refresh progress/);
  assert.doesNotMatch(appShell, /aria-hidden=\{hideLibraryA11y/);
  const barAt = appShell.indexOf("<DownloadBar");
  const inertLib = appShell.indexOf("data-fm-library-inert");
  assert.ok(barAt >= 0 && inertLib > barAt);
});

test("async cmds kept from 206aa", () => {
  assert.match(activateRs, /pub async fn sync_documents_vf_policy/);
  assert.match(activateRs, /pub async fn cancel_google_downloads/);
  assert.match(activateRs, /spawn_blocking/);
});

test("docs mark 206ab; no tip-install/pack", () => {
  assert.match(readme, /1\.0\.206ab/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206ab/);
  assert.match(bugs, /data-fm-cancel-seq|fromDocsCancelChrome|FindFirst/i);
  assert.match(bugs, /No tip-install\/pack|no tip-install/i);
  assert.match(readme, /No tip-install|no tip-install/i);
});
