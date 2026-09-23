import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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

test("cancelDownloadQueue owns Documents refresh cancelled on docs path", () => {
  const cancel = cancelFn();
  assert.match(cancel, /Documents refresh cancelled/);
  assert.match(cancel, /wasDocsVfSync/);
  assert.match(cancel, /docsVfSyncCancelPending/);
  assert.match(cancel, /docsVfSyncCancelToasted/);
  // Toast before any await / before Download cancelled branch.
  const docsAt = cancel.indexOf("Documents refresh cancelled");
  const downloadAt = cancel.indexOf('"Download cancelled"');
  assert.ok(docsAt >= 0, "docs cancel toast present");
  assert.ok(downloadAt > docsAt, "Download cancelled string after docs toast");
  // Early return after docs toast — docs path never reaches Download cancelled emit.
  assert.match(cancel, /if \(wasDocsVfSync\) \{\s*return;/);
});

test("sticky/wasDocs pattern + job.current belt-and-suspenders", () => {
  assert.match(osActivate, /docsVfSyncActive = true/);
  assert.match(osActivate, /docsVfSyncCancelPending/);
  assert.match(osActivate, /docsVfSyncCancelToasted/);
  assert.match(osActivate, /isDocsRefreshJobCurrent/);
  assert.match(osActivate, /scanning documents\|syncing documents\|sync cancelled/i);
  // finally clears active only — sticky survives.
  const sync = osActivate.slice(
    osActivate.indexOf("export async function syncDocumentsVfPolicy"),
    osActivate.indexOf("export async function syncManagedDocumentsRoot"),
  );
  assert.match(sync, /finally \{[\s\S]*docsVfSyncActive = false/);
  assert.doesNotMatch(
    sync.match(/finally \{[\s\S]*?\n  \}/)[0],
    /docsVfSyncCancelToasted = false/,
    "finally must not clear toasted sticky",
  );
});

test("Download cancelled is gated — docs path cannot emit it", () => {
  const cancel = cancelFn();
  // Title ternary only runs after wasDocs early return.
  const earlyReturn = cancel.search(/if \(wasDocsVfSync\) \{\s*return;/);
  const titleAssign = cancel.indexOf('"Download cancelled"');
  assert.ok(earlyReturn >= 0 && titleAssign > earlyReturn);
  // Real download Cancel still present for non-docs / non-restore.
  assert.match(cancel, /Download cancelled/);
  // Deactivate cancelled preserved.
  assert.match(cancel, /Deactivate cancelled/);
});

test("callers skip double-toast via didDocsVfSyncCancelToast", () => {
  assert.match(osActivate, /export function didDocsVfSyncCancelToast/);
  assert.match(activateToggle, /didDocsVfSyncCancelToast/);
  assert.match(desktopSettings, /didDocsVfSyncCancelToast/);
});

test("Cancel chrome discoverable during docs sync (stable Name + testid)", () => {
  assert.match(downloadBar, /Cancel Documents refresh/);
  assert.match(downloadBar, /data-testid="activate-bar-cancel"/);
  assert.match(downloadBar, /activate-bar-cancel-docs|fm-cancel-documents-refresh/);
  assert.match(downloadBar, /isDocsVfSyncJob/);
  // Honesty: docs sync bar not bare Downloading.
  assert.match(downloadBar, /Refreshing Documents/);
});

test("optional: session restore Cancel is not Download cancelled", () => {
  const cancel = cancelFn();
  assert.match(cancel, /Session restore cancelled/);
  assert.match(cancel, /wasRestore/);
});

test("docs mark 206w; no tip-install/pack", () => {
  assert.match(readme, /1\.0\.206w/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206w/);
  assert.match(bugs, /Documents refresh cancelled/);
  assert.match(bugs, /No tip-install\/pack/);
  assert.match(readme, /No tip-install/);
});
