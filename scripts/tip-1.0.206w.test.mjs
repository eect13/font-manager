import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cancelToastKind,
  docsVfSyncOwnsJob,
  isDocsRefreshJobCurrent,
} from "../src/lib/fonts/docs-vf-sync-ownership.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const ownership = readFileSync(
  join(root, "src/lib/fonts/docs-vf-sync-ownership.mjs"),
  "utf8",
);
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

function cancelFn() {
  const start = osActivate.indexOf("export function cancelDownloadQueue");
  const end = osActivate.indexOf("export function pauseDownloadQueue");
  assert.ok(start >= 0 && end > start);
  return osActivate.slice(start, end);
}

test("206w keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.equal(tauri.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("P0 assert matrix: Scanning Documents is not docs-owned without sticky", () => {
  // Activate + docs sync share this string — bare match was the HOLD collision.
  assert.equal(
    docsVfSyncOwnsJob({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Scanning Documents…",
    }),
    false,
  );
  assert.equal(isDocsRefreshJobCurrent("Scanning Documents…"), false);
  assert.equal(
    cancelToastKind({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Scanning Documents…",
    }),
    "download",
  );
});

test("P0 assert matrix: sticky or docs-only currents ⇒ docs-owned", () => {
  assert.equal(
    docsVfSyncOwnsJob({
      docsVfSyncActive: true,
      docsVfSyncCancelPending: false,
      current: "Scanning Documents…",
    }),
    true,
  );
  assert.equal(
    docsVfSyncOwnsJob({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: true,
      current: "Scanning Documents…",
    }),
    true,
  );
  assert.equal(isDocsRefreshJobCurrent("Syncing Documents (0/12)"), true);
  assert.equal(isDocsRefreshJobCurrent("Syncing Documents…"), true);
  assert.equal(isDocsRefreshJobCurrent("Sync cancelled"), true);
  assert.equal(isDocsRefreshJobCurrent("Refreshing Documents"), true);
  assert.equal(isDocsRefreshJobCurrent("Refreshing Documents folder…"), true);
  assert.equal(
    docsVfSyncOwnsJob({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Syncing Documents (3/10)",
    }),
    true,
  );
});

test("P0 assert matrix: Restoring N/T ⇒ session-restore (not Download / not Documents)", () => {
  assert.equal(
    cancelToastKind({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Restoring 52/53",
    }),
    "session-restore",
  );
  assert.equal(
    docsVfSyncOwnsJob({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Restoring 52/53",
    }),
    false,
  );
});

test("ownership helper drops bare scanning documents from docs belt", () => {
  // Regex source must not include bare scanning (Activate shares that string).
  const belt = ownership.match(
    /return \/([^/]+)\/i\.test/,
  );
  assert.ok(belt, "isDocsRefreshJobCurrent regex present");
  assert.doesNotMatch(belt[1], /scanning/i);
  assert.match(belt[1], /syncing documents/);
  assert.match(belt[1], /sync cancelled/);
  assert.match(belt[1], /refresh/);
  assert.match(osActivate, /docsVfSyncOwnsJob/);
  assert.match(osActivate, /from "\.\/docs-vf-sync-ownership\.mjs"/);
  // download-bar must not OR bare scanning into docsSync.
  assert.match(downloadBar, /const docsSync = isDocsVfSyncJob\(\)/);
  assert.doesNotMatch(
    downloadBar,
    /isDocsVfSyncJob\(\) \|\| \/syncing documents\|scanning documents/i,
  );
});

test("cancelDownloadQueue suppresses Download cancelled on docs path (no early Documents toast)", () => {
  const cancel = cancelFn();
  assert.match(cancel, /wasDocsVfSync/);
  assert.match(cancel, /armDocsCancelFromChrome\(\)/);
  assert.match(osActivate, /docsVfSyncCancelPending = true/);
  assert.match(cancel, /docsVfSyncOwnsJob/);
  // Amend: Documents refresh cancelled toast deferred to Rust-confirmed cancelled (callers).
  assert.doesNotMatch(cancel, /Documents refresh cancelled/);
  // 206ad: docs path arms via armDocsCancelFromChrome (immediate IPC there).
  assert.match(cancel, /if \(wasDocsVfSync\)/);
  assert.match(osActivate, /tauriInvoke\("cancel_google_downloads"\)/);
  const earlyReturn = cancel.search(/if \(wasDocsVfSync\)/);
  const titleAssign = cancel.indexOf('"Download cancelled"');
  assert.ok(earlyReturn >= 0 && titleAssign > earlyReturn);
  assert.match(cancel, /Download cancelled/);
  assert.match(cancel, /Deactivate cancelled/);
  assert.match(cancel, /Session restore cancelled/);
  assert.match(cancel, /wasRestore/);
});

test("sticky arm before Refresh toast Cancel + sync arms before beginOwnedJob", () => {
  assert.match(osActivate, /export function armDocsVfSyncOwnership/);
  assert.match(activateToggle, /armDocsVfSyncOwnership\(\)/);
  assert.match(desktopSettings, /armDocsVfSyncOwnership\(\)/);
  const armAtToggle = activateToggle.indexOf("armDocsVfSyncOwnership()");
  const toastAtToggle = activateToggle.indexOf("Refreshing Documents folder…");
  assert.ok(armAtToggle >= 0 && armAtToggle < toastAtToggle);
  const sync = osActivate.slice(
    osActivate.indexOf("export async function syncDocumentsVfPolicy"),
    osActivate.indexOf("export async function syncManagedDocumentsRoot"),
  );
  assert.match(sync, /docsVfSyncActive = true/);
  // Real call site (skip comment that mentions beginOwnedJob before the assignment).
  const beginCall = sync.search(/if \(!beginOwnedJob\(/);
  const activeAt = sync.indexOf("docsVfSyncActive = true");
  assert.ok(activeAt >= 0 && beginCall > activeAt, "sticky before beginOwnedJob");
  assert.match(sync, /finally \{[\s\S]*docsVfSyncActive = false/);
  assert.doesNotMatch(
    sync.match(/finally \{[\s\S]*?\n  \}/)[0],
    /docsVfSyncCancelToasted = false/,
    "finally must not clear toasted sticky",
  );
});

test("callers toast Documents refresh cancelled on Rust cancelled; skip via didDocsVfSyncCancelToast", () => {
  assert.match(osActivate, /export function didDocsVfSyncCancelToast/);
  assert.match(activateToggle, /didDocsVfSyncCancelToast/);
  assert.match(desktopSettings, /didDocsVfSyncCancelToast/);
  assert.match(activateToggle, /Documents refresh cancelled/);
  assert.match(desktopSettings, /Documents refresh cancelled/);
});

test("Cancel chrome discoverable during docs sync (stable Name + testid)", () => {
  // Name/id SoT is cancelChromeA11y — download-bar must wire it for docs Cancel
  assert.match(downloadBar, /cancelChromeA11y/);
  assert.match(downloadBar, /showDocsCancelIdentity:\s*docsChrome/);
  assert.match(downloadBar, /data-testid="activate-bar-cancel"/);
  assert.match(downloadBar, /isDocsVfSyncJob/);
  assert.match(downloadBar, /Refreshing Documents/);
  assert.match(downloadBar, /const docsSync = isDocsVfSyncJob\(\)/);
  // Helper still exports Cancel Documents refresh identity for cancellable docs
  assert.match(ownership, /Cancel Documents refresh/);
  assert.match(ownership, /fm-cancel-documents-refresh/);
});

test("docs mark 206w; Scanning collision note; no tip-install/pack", () => {
  assert.match(readme, /1\.0\.206w/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206w/);
  assert.match(bugs, /Documents refresh cancelled/);
  assert.match(bugs, /Scanning Documents/);
  assert.match(bugs, /No tip-install\/pack/);
  assert.match(readme, /No tip-install/);
  assert.match(readme, /Scanning Documents/);
});
