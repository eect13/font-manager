import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  advanceDocsCancelChrome,
  cancelChromeA11y,
  cancelChromeVisibleLabel,
  cancelToastKind,
  docsCancelChromeHosts,
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

test("206z keeps ProductVersion 1.0.206", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.equal(tauri.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("bar Gate D visible Name via cancelChromeVisibleLabel", () => {
  assert.equal(
    cancelChromeVisibleLabel({ showDocsCancelIdentity: true }),
    "Cancel Documents refresh",
  );
  assert.equal(cancelChromeVisibleLabel({ dismissHold: true }), "Dismiss");
  assert.equal(cancelChromeVisibleLabel({ restoring: true }), "Cancel session restore");
  assert.equal(cancelChromeVisibleLabel({}), "Cancel");
  assert.match(ownership, /cancelChromeVisibleLabel/);
  assert.match(downloadBar, /cancelChromeVisibleLabel/);
});

test("download-bar docs Cancel uses Gate D visible Name + cancelChromeA11y id", () => {
  assert.match(downloadBar, /cancelChromeVisibleLabel\(\{/);
  assert.match(downloadBar, /showDocsCancelIdentity:\s*docsChrome/);
  assert.match(downloadBar, /cancelChromeA11y\(/);
  const cancelBtn = downloadBar.match(
    /key="activate-bar-cancel"[\s\S]*?<\/Button>/,
  );
  assert.ok(cancelBtn, "activate-bar-cancel Button present");
  assert.match(cancelBtn[0], /cancelChromeVisibleLabel/);
  assert.doesNotMatch(
    cancelBtn[0],
    />\s*Cancel\s*</,
    "bare Cancel text node would make UIA Name miss Gate D",
  );
  assert.match(cancelBtn[0], /X aria-hidden/);
  const barDocs = cancelChromeA11y({ showDocsCancelIdentity: true });
  assert.equal(barDocs.id, "fm-cancel-documents-refresh");
  assert.equal(barDocs["aria-label"], "Cancel Documents refresh");
  assert.equal(barDocs["data-automation-id"], "fm-cancel-documents-refresh");
});

test("toast Cancel is short Cancel only — no Gate D Name/id/data-automation-id", () => {
  assert.match(toastAction, /createElement\(\s*"button"/);
  assert.match(toastAction, /cancelDownloadQueue/);
  assert.match(toastAction, /data-testid":\s*"docs-toast-cancel"/);
  // Short visible + accessible Cancel (attrs + children only — ignore file header comments)
  const body = toastAction.slice(toastAction.indexOf("export function docsCancelToastAction"));
  assert.match(body, /"aria-label":\s*"Cancel"/);
  assert.match(body, /,\s*"Cancel",?\s*\)/);
  // Must NOT carry Gate D identity on the toast button
  assert.doesNotMatch(body, /Cancel Documents refresh/);
  assert.doesNotMatch(body, /fm-cancel-documents-refresh/);
  assert.doesNotMatch(body, /data-automation-id/);
  assert.doesNotMatch(body, /showDocsCancelIdentity/);
  assert.doesNotMatch(body, /cancelChromeA11y/);
  assert.doesNotMatch(body, /cancelChromeVisibleLabel/);
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

test("app-shell: Cancel chrome outside library inert", () => {
  const hosts = docsCancelChromeHosts();
  assert.match(appShell, new RegExp(hosts.shellChromeAttr));
  assert.match(appShell, new RegExp(hosts.libraryInertAttr));
  assert.match(appShell, /shouldHideLibraryFromA11yDuringDocsJob/);
  assert.match(appShell, /inert=\{hideLibraryA11y/);
  // 206aa: no aria-hidden on library (GetClickablePoint hang)
  assert.doesNotMatch(appShell, /aria-hidden=\{hideLibraryA11y/);

  const chromeAt = appShell.indexOf(`data-fm-shell-chrome`);
  const barAt = appShell.indexOf("<DownloadBar");
  const inertAt = appShell.indexOf(`data-fm-library-inert`);
  assert.ok(chromeAt >= 0 && barAt > chromeAt, "DownloadBar inside shell chrome marker");
  assert.ok(inertAt > barAt, "library inert wrapper after DownloadBar");
  const chromeBlock = appShell.slice(chromeAt, inertAt);
  assert.doesNotMatch(chromeBlock, /\binert=/);
  const inertBlock = appShell.slice(inertAt, inertAt + 280);
  assert.match(inertBlock, /inert=\{hideLibraryA11y/);
  assert.equal(hosts.cancelName, "Cancel Documents refresh");
  assert.equal(hosts.toastCancelName, "Cancel");
});

test("showDocsCancelIdentity only while cancellable (206x honesty kept)", () => {
  const t0 = 2_000_000;
  let s = advanceDocsCancelChrome({
    docsOwns: true,
    cancelChromeEligible: true,
    now: t0,
  });
  assert.equal(s.showDocsCancelIdentity, true);
  assert.equal(
    cancelChromeVisibleLabel({ showDocsCancelIdentity: s.showDocsCancelIdentity }),
    "Cancel Documents refresh",
  );
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
    shouldHideLibraryFromA11yDuringDocsJob({
      docsOwns: false,
      cancelChromeEligible: true,
    }),
    false,
  );
});

test("docs mark 206z amend; bar-only Gate D; no tip-install/pack", () => {
  assert.match(readme, /1\.0\.206z/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206z/);
  assert.match(bugs, /bar-only|bar only|Gate D identity on \*\*bar only\*\*|progress bar only/i);
  assert.match(readme, /bar-only|bar only|Gate D.*bar|progress bar only/i);
  assert.match(bugs, /cancelChromeVisibleLabel|data-fm-shell-chrome/);
  assert.match(readme, /cancelChromeVisibleLabel|FindFirst/);
  assert.match(bugs, /No tip-install\/pack/);
  assert.match(readme, /No tip-install/);
  assert.match(readme, /1\.0\.206y/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206y/);
  assert.match(readme, /1\.0\.206x/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206x/);
});
