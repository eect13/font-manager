import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  advanceDocsCancelChrome,
  cancelChromeA11y,
  cancelToastKind,
  DOCS_CANCEL_MIN_DISPLAY_MS,
  docsVfSyncOwnsJob,
  isDocsRefreshJobCurrent,
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
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = readFileSync(join(root, "src/version.ts"), "utf8");

test("206x keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.equal(tauri.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("DOCS_CANCEL_MIN_DISPLAY_MS is 1000", () => {
  assert.equal(DOCS_CANCEL_MIN_DISPLAY_MS, 1000);
  assert.match(ownership, /DOCS_CANCEL_MIN_DISPLAY_MS\s*=\s*1000/);
});

test("docs Cancel identity latches ≥1s after paint (pure helper)", () => {
  const t0 = 1_000_000;
  let s = advanceDocsCancelChrome({
    docsOwns: true,
    cancelChromeEligible: true,
    now: t0,
  });
  assert.equal(s.latched, true);
  assert.equal(s.paintedAt, t0);
  assert.equal(s.showDocsCancelIdentity, true);
  assert.equal(s.holdCancelChrome, true);

  // Mid-window, still docs-owned
  s = advanceDocsCancelChrome({
    docsOwns: true,
    cancelChromeEligible: true,
    now: t0 + 400,
    latched: s.latched,
    paintedAt: s.paintedAt,
  });
  assert.equal(s.showDocsCancelIdentity, true);
  assert.equal(s.paintedAt, t0, "paintedAt must not reset on progress ticks");

  // Docs job ends at 600ms — identity + hold until 1000ms
  s = advanceDocsCancelChrome({
    docsOwns: false,
    cancelChromeEligible: false,
    now: t0 + 600,
    latched: s.latched,
    paintedAt: s.paintedAt,
  });
  assert.equal(s.showDocsCancelIdentity, true);
  assert.equal(s.holdCancelChrome, true);
  assert.ok(s.remainingMinMs > 0);

  // Exactly at +1000ms — min window closed
  s = advanceDocsCancelChrome({
    docsOwns: false,
    cancelChromeEligible: false,
    now: t0 + 1000,
    latched: s.latched,
    paintedAt: s.paintedAt,
  });
  assert.equal(s.showDocsCancelIdentity, false);
  assert.equal(s.holdCancelChrome, false);
  assert.equal(s.latched, false);
});

test("Activate Scanning Documents does not get docs Cancel aria/id", () => {
  assert.equal(
    docsVfSyncOwnsJob({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Scanning Documents…",
    }),
    false,
  );
  assert.equal(isDocsRefreshJobCurrent("Scanning Documents…"), false);
  const s = advanceDocsCancelChrome({
    docsOwns: false,
    cancelChromeEligible: true,
    now: 50,
  });
  assert.equal(s.showDocsCancelIdentity, false);
  assert.equal(s.latched, false);
  const a11y = cancelChromeA11y({
    showDocsCancelIdentity: s.showDocsCancelIdentity,
    restoring: false,
  });
  assert.equal(a11y["aria-label"], "Cancel");
  assert.equal(a11y.id, undefined);
  assert.equal(
    cancelToastKind({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Scanning Documents…",
    }),
    "download",
  );
});

test("Restore still gets Cancel session restore (not Documents)", () => {
  assert.equal(
    cancelToastKind({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Restoring 52/53",
    }),
    "session-restore",
  );
  const a11y = cancelChromeA11y({
    showDocsCancelIdentity: false,
    restoring: true,
  });
  assert.equal(a11y["aria-label"], "Cancel session restore");
  assert.equal(a11y.id, "fm-cancel-session-restore");
  assert.equal(a11y["data-cancel-kind"], "session-restore");
  // download-bar wires restore via cancelChromeA11y({ restoring }) — SoT in helper
  assert.match(downloadBar, /cancelChromeA11y\(/);
  assert.match(downloadBar, /restoring/);
});

test("206w ownership matrix still passes (sticky + belt + Scanning collision)", () => {
  // Bare scanning → not docs
  assert.equal(
    docsVfSyncOwnsJob({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Scanning Documents…",
    }),
    false,
  );
  // Sticky active with scanning → docs
  assert.equal(
    docsVfSyncOwnsJob({
      docsVfSyncActive: true,
      docsVfSyncCancelPending: false,
      current: "Scanning Documents…",
    }),
    true,
  );
  // Sticky pending → docs
  assert.equal(
    docsVfSyncOwnsJob({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: true,
      current: "Scanning Documents…",
    }),
    true,
  );
  // Docs-only currents
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
  // Restore not docs
  assert.equal(
    docsVfSyncOwnsJob({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Restoring 52/53",
    }),
    false,
  );
  // Regex must not include bare scanning
  const belt = ownership.match(/return \/([^/]+)\/i\.test/);
  assert.ok(belt, "isDocsRefreshJobCurrent regex present");
  assert.doesNotMatch(belt[1], /scanning/i);
  assert.match(belt[1], /syncing documents/);
  assert.match(belt[1], /sync cancelled/);
  assert.match(belt[1], /refresh/);
});

test("download-bar latches docs Cancel ≥1s; stable key; no tree storm", () => {
  assert.match(downloadBar, /advanceDocsCancelChrome/);
  assert.match(downloadBar, /docsCancelLatch/);
  assert.match(downloadBar, /holdDocsCancelChrome/);
  assert.match(downloadBar, /key="activate-bar-cancel"/);
  assert.match(downloadBar, /data-testid="activate-bar-cancel"/);
  assert.match(downloadBar, /cancelChromeA11y/);
  assert.match(downloadBar, /showDocsCancelIdentity:\s*docsChrome/);
  assert.match(downloadBar, /const docsSync = isDocsVfSyncJob\(\)/);
  assert.match(downloadBar, /Refreshing Documents/);
  // Do not reintroduce bare scanning OR into docsSync
  assert.doesNotMatch(
    downloadBar,
    /isDocsVfSyncJob\(\) \|\| \/syncing documents\|scanning documents/i,
  );
  // Hold path: honest Dismiss (dismissDownloadBar) — never Cancel Documents refresh Name/id
  assert.match(downloadBar, /holdDocsCancelChrome \? \(/);
  assert.match(downloadBar, /dismissHold:\s*true/);
  assert.match(downloadBar, /dismissDownloadBar\(\)/);
  assert.match(downloadBar, /Refreshing complete/);
  assert.match(downloadBar, /key="activate-bar-dismiss"/);
  assert.match(downloadBar, />\s*Dismiss\s*</);
  // Hold JSX must not hardcode Cancel Documents refresh / fm-cancel-documents-refresh
  const holdBlock = downloadBar.match(
    /holdDocsCancelChrome \? \([\s\S]*?\) : job\.running \|\| job\.paused/,
  );
  assert.ok(holdBlock, "holdDocsCancelChrome ternary present");
  assert.doesNotMatch(holdBlock[0], /Cancel Documents refresh/);
  assert.doesNotMatch(holdBlock[0], /fm-cancel-documents-refresh/);
  assert.doesNotMatch(holdBlock[0], /documents-refresh/);
  // job.current family names suppressed during docs chrome (tree storm)
  assert.match(
    downloadBar,
    /!scanning && !restoring && !docsChrome/,
  );
});

test("cancelChromeA11y docs attrs include AutomationId mirror", () => {
  const docs = cancelChromeA11y({ showDocsCancelIdentity: true });
  assert.equal(docs["aria-label"], "Cancel Documents refresh");
  assert.equal(docs.id, "fm-cancel-documents-refresh");
  assert.equal(docs["data-automation-id"], "fm-cancel-documents-refresh");
  assert.equal(docs["data-cancel-kind"], "documents-refresh");
  assert.equal(docs["data-docs-cancel"], "activate-bar-cancel-docs");
});

test("cancelChromeA11y dismissHold is honest Dismiss (not Cancel Documents refresh)", () => {
  const dismiss = cancelChromeA11y({ dismissHold: true, showDocsCancelIdentity: true });
  assert.equal(dismiss["aria-label"], "Dismiss Documents refresh");
  assert.equal(dismiss.id, "fm-dismiss-documents-refresh");
  assert.equal(dismiss["data-automation-id"], "fm-dismiss-documents-refresh");
  assert.equal(dismiss["data-cancel-kind"], "dismiss");
  assert.notEqual(dismiss["aria-label"], "Cancel Documents refresh");
  assert.notEqual(dismiss.id, "fm-cancel-documents-refresh");
  assert.equal(dismiss["data-docs-cancel"], undefined);
});

test("docs mark 206x; no tip-install/pack; 206w ownership kept", () => {
  assert.match(readme, /1\.0\.206x/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206x/);
  assert.match(bugs, /Cancel Documents refresh/);
  assert.match(bugs, /Dismiss Documents refresh|honest Dismiss|dismissHold/);
  assert.match(bugs, /≥1s|>=1s|1s/);
  assert.match(bugs, /No tip-install\/pack/);
  assert.match(readme, /No tip-install/);
  assert.match(readme, /Dismiss Documents refresh|honest Dismiss/);
  // 206w amend kept
  assert.match(readme, /1\.0\.206w/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206w/);
  assert.match(ownership, /Scanning Documents/);
  assert.doesNotMatch(
    ownership.match(/return \/([^/]+)\/i\.test/)[1],
    /scanning/i,
  );
});
