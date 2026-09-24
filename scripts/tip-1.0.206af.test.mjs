import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const mainRs = readFileSync(join(root, "src-tauri/src/main.rs"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const downloadBar = readFileSync(
  join(root, "src/components/font-studio/download-bar.tsx"),
  "utf8",
);
const appShell = readFileSync(
  join(root, "src/components/font-studio/app-shell.tsx"),
  "utf8",
);
const ownership = readFileSync(
  join(root, "src/lib/fonts/docs-vf-sync-ownership.mjs"),
  "utf8",
);
const {
  cancelToastKind,
  isDocsRefreshJobCurrent,
} = await import(join(root, "src/lib/fonts/docs-vf-sync-ownership.mjs"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = readFileSync(join(root, "src/version.ts"), "utf8");

test("206af keeps ProductVersion 1.0.206", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.equal(tauri.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("P0: sessionLive from Refresh arm until sync finally", () => {
  assert.match(osActivate, /docsVfSyncSessionLive/);
  assert.match(osActivate, /isDocsVfSyncSessionLive/);
  const arm = osActivate.slice(
    osActivate.indexOf("export function armDocsVfSyncOwnership"),
    osActivate.indexOf("export function isDocsVfSyncJob"),
  );
  assert.match(arm, /docsVfSyncSessionLive = true/);
  const sync = osActivate.slice(
    osActivate.indexOf("export async function syncDocumentsVfPolicy"),
    osActivate.indexOf("export async function syncManagedDocumentsRoot"),
  );
  assert.match(sync, /docsVfSyncSessionLive = true/);
  assert.match(sync, /docsVfSyncSessionLive = false/);
  const clear = osActivate.slice(
    osActivate.indexOf("export function clearDocsVfSyncCancelPending"),
    osActivate.indexOf("export function isDocsCancelArmed"),
  );
  assert.match(clear, /docsVfSyncSessionLive = false/);
});

test("P0: Escape mid-session arms; after settle sessionLive gates false", () => {
  const fn = osActivate.slice(
    osActivate.indexOf("export function cancelDocsVfSyncFromShortcut"),
    osActivate.indexOf("export function setDocsCancelChromePresented"),
  );
  assert.match(fn, /docsVfSyncSessionLive/);
  assert.match(fn, /return false/);
  assert.match(fn, /cancelDownloadQueue\(\{ fromDocsCancelChrome: true \}\)/);
  assert.match(appShell, /Escape/);
  assert.match(appShell, /cancelDocsVfSyncFromShortcut/);
});

test("P0: tray cancel emits docs-vf-cancel-requested for JS toast path", () => {
  assert.match(activateRs, /docs-vf-cancel-requested/);
  assert.match(activateRs, /pub async fn cancel_google_downloads\(app: AppHandle\)/);
  assert.match(mainRs, /cancel_docs_refresh/);
  assert.match(osActivate, /docs-vf-cancel-requested/);
  assert.match(osActivate, /cancelDocsVfSyncFromShortcut/);
});

test("P0: UIA Cancel Name/id — no title/valuenow steal; labelledby", () => {
  assert.match(downloadBar, /fm-cancel-documents-refresh-label/);
  assert.match(downloadBar, /aria-labelledby/);
  assert.doesNotMatch(downloadBar, /aria-valuenow=\{getDocsCancelSeq/);
  assert.doesNotMatch(downloadBar, /title=\{getDocsCancelSeq/);
  assert.match(ownership, /Cancel Documents refresh/);
  assert.match(ownership, /fm-cancel-documents-refresh/);
  assert.match(osActivate, /removeAttribute\("title"\)/);
  // shell chrome must not be a named region
  assert.doesNotMatch(appShell, /aria-label=\{hideLibraryA11y/);
});

test("P0 HOLD: Activate Stopping… without sticky ≠ documents-refresh", () => {
  assert.equal(isDocsRefreshJobCurrent("Stopping…"), false);
  assert.equal(isDocsRefreshJobCurrent("Stopping..."), false);
  assert.notEqual(
    cancelToastKind({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Stopping…",
    }),
    "documents-refresh",
  );
  assert.equal(
    cancelToastKind({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Stopping…",
    }),
    "download",
  );
  // Docs mid-abort still owned via sticky pending (not bare Stopping).
  assert.equal(
    cancelToastKind({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: true,
      current: "Stopping…",
    }),
    "documents-refresh",
  );
  assert.doesNotMatch(ownership, /\|stopping/i);
});

test("P0: 206ae throttle + 206ad keepers", () => {
  assert.match(activateRs, /docs_vf_emit_progress_throttle_ms/);
  assert.match(activateRs, /\b900\b/);
  assert.match(activateRs, /docs_vf_emit_every_n_dirs/);
  const arm = osActivate.slice(
    osActivate.indexOf("function armDocsCancelFromChrome"),
    osActivate.indexOf("export function cancelDownloadQueue"),
  );
  assert.match(arm, /tauriInvoke\("cancel_google_downloads"\)/);
  assert.match(arm, /setTimeout\(\s*\(\)\s*=>\s*finishDocsCancelTeardown/);
  assert.match(activateRs, /purge_redundant_statics_in_dir_cancelable/);
});

test("docs mark 206af; no tip-install/pack", () => {
  assert.match(readme, /1\.0\.206af/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206af/);
  assert.match(bugs, /sessionLive|Escape|tray|UIA|labelledby/i);
  assert.match(bugs, /No tip-install\/pack|no tip-install/i);
});
