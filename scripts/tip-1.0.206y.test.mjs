import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  advanceDocsCancelChrome,
  cancelChromeA11y,
  cancelToastKind,
  docsVfSyncOwnsJob,
  isDocsRefreshJobCurrent,
  shouldHideLibraryFromA11yDuringDocsJob,
} from "../src/lib/fonts/docs-vf-sync-ownership.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ownership = readFileSync(
  join(root, "src/lib/fonts/docs-vf-sync-ownership.mjs"),
  "utf8",
);
const downloadBar = readFileSync(
  join(root, "src/components/font-studio/download-bar.tsx"),
  "utf8",
);
const appShell = readFileSync(
  join(root, "src/components/font-studio/app-shell.tsx"),
  "utf8",
);
const toastAction = readFileSync(
  join(root, "src/lib/fonts/docs-cancel-toast-action.tsx"),
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

test("206y keeps ProductVersion 1.0.206", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.equal(tauri.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("shouldHideLibraryFromA11yDuringDocsJob — docs+cancellable only", () => {
  assert.equal(
    shouldHideLibraryFromA11yDuringDocsJob({
      docsOwns: true,
      cancelChromeEligible: true,
    }),
    true,
  );
  assert.equal(
    shouldHideLibraryFromA11yDuringDocsJob({
      docsOwns: true,
      cancelChromeEligible: false,
    }),
    false,
    "post-end / idle must not keep library aria-hidden",
  );
  assert.equal(
    shouldHideLibraryFromA11yDuringDocsJob({
      docsOwns: false,
      cancelChromeEligible: true,
    }),
    false,
    "Activate scan must not hide library",
  );
  assert.match(ownership, /shouldHideLibraryFromA11yDuringDocsJob/);
});

test("app-shell hides route/library during docs; DownloadBar outside aria-hidden", () => {
  assert.match(appShell, /shouldHideLibraryFromA11yDuringDocsJob/);
  assert.match(appShell, /isDocsVfSyncJob\(\)/);
  assert.match(appShell, /hideLibraryA11y/);
  assert.match(appShell, /aria-hidden=\{hideLibraryA11y/);
  assert.match(appShell, /inert=\{hideLibraryA11y/);
  assert.match(appShell, /aria-busy=\{hideLibraryA11y/);
  // DownloadBar must appear before the aria-hidden content wrapper
  const barAt = appShell.indexOf("<DownloadBar");
  const hideAt = appShell.indexOf("aria-hidden={hideLibraryA11y");
  assert.ok(barAt >= 0 && hideAt > barAt, "DownloadBar above aria-hidden content");
  // Content wrapper (not DownloadBar) carries aria-hidden
  const barBlock = appShell.slice(barAt, hideAt);
  assert.doesNotMatch(barBlock, /aria-hidden/);
});

test("download-bar Cancel spreads cancelChromeA11y id onto Button (real <button>)", () => {
  assert.match(downloadBar, /cancelChromeA11y\(/);
  assert.match(downloadBar, /showDocsCancelIdentity:\s*docsChrome/);
  assert.match(downloadBar, /data-testid="activate-bar-cancel"/);
  // id comes from helper spread — not hardcoded wrapper
  assert.match(ownership, /id:\s*"fm-cancel-documents-refresh"/);
  const docs = cancelChromeA11y({ showDocsCancelIdentity: true });
  assert.equal(docs.id, "fm-cancel-documents-refresh");
  assert.equal(docs["aria-label"], "Cancel Documents refresh");
  assert.equal(docs["data-automation-id"], "fm-cancel-documents-refresh");
  // Suppress aria-live storms during docs chrome
  assert.match(downloadBar, /aria-live=\{docsChrome \|\| holdDismissChrome/);
  // job.current family names still suppressed during docs
  assert.match(downloadBar, /!scanning && !restoring && !docsChrome/);
});

test("toast Cancel while docs-owned is real button + cancelDownloadQueue (Gate D Name bar-only since 206z amend)", () => {
  // 206z amend (Skye HOLD): Gate D Name/id on progress bar only; toast = short Cancel.
  assert.match(toastAction, /createElement\(\s*"button"/);
  assert.match(toastAction, /cancelDownloadQueue/);
  const body = toastAction.slice(toastAction.indexOf("export function docsCancelToastAction"));
  assert.doesNotMatch(body, /Cancel Documents refresh/);
  assert.doesNotMatch(body, /fm-cancel-documents-refresh/);
  assert.doesNotMatch(body, /data-automation-id/);
  assert.match(activateToggle, /docsCancelToastAction\(\)/);
  assert.match(desktopSettings, /docsCancelToastAction\(\)/);
  const refreshToast = activateToggle.match(
    /toast\.message\("Refreshing Documents folder…",[\s\S]*?\}\);/,
  );
  assert.ok(refreshToast, "Refreshing Documents toast present");
  assert.match(refreshToast[0], /docsCancelToastAction\(\)/);
  assert.doesNotMatch(
    refreshToast[0],
    /action:\s*\{\s*label:\s*"Cancel"/,
  );
});

test("showDocsCancelIdentity only while cancellable (206x honesty kept)", () => {
  const t0 = 2_000_000;
  let s = advanceDocsCancelChrome({
    docsOwns: true,
    cancelChromeEligible: true,
    now: t0,
  });
  assert.equal(s.showDocsCancelIdentity, true);
  s = advanceDocsCancelChrome({
    docsOwns: false,
    cancelChromeEligible: false,
    now: t0 + 400,
    latched: s.latched,
    paintedAt: s.paintedAt,
  });
  assert.equal(s.showDocsCancelIdentity, false);
  assert.equal(s.holdDismissChrome, true);
  const dismiss = cancelChromeA11y({ dismissHold: true });
  assert.equal(dismiss["aria-label"], "Dismiss Documents refresh");
  assert.notEqual(dismiss.id, "fm-cancel-documents-refresh");
});

test("206w ownership matrix — Activate scan ≠ docs Cancel toast", () => {
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
  assert.equal(
    cancelToastKind({
      docsVfSyncActive: true,
      docsVfSyncCancelPending: false,
      current: "Scanning Documents…",
    }),
    "documents-refresh",
  );
  assert.equal(
    cancelToastKind({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Restoring 52/53",
    }),
    "session-restore",
  );
  // Hide helper must not fire for bare Activate scan
  assert.equal(
    shouldHideLibraryFromA11yDuringDocsJob({
      docsOwns: false,
      cancelChromeEligible: true,
    }),
    false,
  );
});

test("docs mark 206y; no tip-install/pack; cancelChromeA11y SoT", () => {
  assert.match(readme, /1\.0\.206y/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206y/);
  assert.match(bugs, /shouldHideLibraryFromA11yDuringDocsJob|aria-hidden|FindFirst/);
  assert.match(readme, /shouldHideLibraryFromA11yDuringDocsJob|aria-hidden|≤300ms|FindFirst/);
  assert.match(bugs, /No tip-install\/pack/);
  assert.match(readme, /No tip-install/);
  assert.match(bugs, /cancelChromeA11y/);
  assert.match(readme, /cancelChromeA11y/);
  // 206x kept
  assert.match(readme, /1\.0\.206x/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206x/);
});
