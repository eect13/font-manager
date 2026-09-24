import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const confirmDlg = readFileSync(
  join(root, "src/components/font-studio/activate-confirm-dialog.tsx"),
  "utf8",
);
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");

/** Extract cancelDownloadQueue body for structural asserts. */
function cancelBody() {
  const start = osActivate.indexOf("export function cancelDownloadQueue(");
  assert.ok(start >= 0, "cancelDownloadQueue missing");
  const end = osActivate.indexOf("\nexport function pauseDownloadQueue()", start);
  assert.ok(end > start, "pauseDownloadQueue after cancel missing");
  return osActivate.slice(start, end);
}

/** Simulate Cancel settle: prefix Off, remainder Live (pending cleared). */
function settleCancelRemove(activated, pendingDeactivate, batchIds, done) {
  const prefix = batchIds.slice(0, Math.min(done, batchIds.length));
  const prefixSet = new Set(prefix);
  const remSet = new Set(batchIds.filter((id) => !prefixSet.has(id)));
  const liveAfter = activated.filter((id) => !prefixSet.has(id));
  return {
    activated: liveAfter,
    pendingDeactivate: pendingDeactivate.filter((id) => !prefixSet.has(id) && !remSet.has(id)),
    prefix,
    remainder: batchIds.filter((id) => !prefixSet.has(id)),
    liveRemain: liveAfter.filter((id) => remSet.has(id)),
    toastStayLive: liveAfter.some((id) => remSet.has(id)),
  };
}

/**
 * 1.0.206k soft-lie: even when keepFailed.length > 0 (stale Activate fails), Cancel mid-Deactivate
 * must still restore Live for never-unloaded (same settle as clean Cancel).
 */
function settleCancelRemoveWithKeepFailed(activated, pendingDeactivate, batchIds, done, keepFailed) {
  assert.ok(keepFailed.length > 0, "fixture requires keepFailed");
  // Production: wasRemove runs restore independent of keepFailed toast branch.
  return { ...settleCancelRemove(activated, pendingDeactivate, batchIds, done), keepFailed };
}

test("206k keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.207");
  assert.match(version, /1\.0\.207/);
});

test("P0 beginOwnedJob(remove) clears lastFailedNames", () => {
  const start = osActivate.indexOf("function beginOwnedJob(");
  assert.ok(start >= 0);
  const body = osActivate.slice(start, start + 1200);
  assert.match(body, /if \(owner === "remove"\) lastFailedNames = \[\]/);
  assert.match(body, /1\.0\.206k/);
});

test("P0 Cancel wasRemove always restores Live — independent of keepFailed", () => {
  const body = cancelBody();
  // Must NOT gate restore behind keepFailed-first branch (206j soft-lie regression).
  assert.doesNotMatch(
    body,
    /if \(keepFailed\.length\) \{[\s\S]*?\n\s*\} else if \(wasRemove\)/,
  );
  // wasRemove first: prefix confirm + restore before any keepFailed toast.
  const wasIdx = body.indexOf("if (wasRemove)");
  const keepIdx = body.indexOf("else if (keepFailed.length)");
  const restoreIdx = body.indexOf("await restoreRemoveRemainderLive");
  const confirmIdx = body.indexOf("await confirmRemovePrefixByDone");
  assert.ok(wasIdx >= 0, "wasRemove branch");
  assert.ok(keepIdx > wasIdx, "keepFailed toast only after wasRemove");
  assert.ok(restoreIdx > wasIdx && restoreIdx < keepIdx, "restore inside wasRemove, before keepFailed");
  assert.ok(confirmIdx > wasIdx && confirmIdx < keepIdx, "prefix confirm inside wasRemove");
  assert.match(body, /1\.0\.206k/);
  assert.match(body, /remaining stay Live/);
});

test("P0 wasRemove && keepFailed.length still restores Live for never-unloaded", () => {
  const batch = ["a", "b", "c", "d", "e"];
  const keepFailed = ["SomeActivateFail"];
  const st = settleCancelRemoveWithKeepFailed(batch.slice(), batch.slice(), batch, 2, keepFailed);
  assert.deepEqual(st.prefix, ["a", "b"]);
  assert.deepEqual(st.remainder, ["c", "d", "e"]);
  assert.deepEqual(st.activated, ["c", "d", "e"]);
  assert.deepEqual(st.liveRemain, ["c", "d", "e"]);
  assert.equal(st.toastStayLive, true);
  assert.equal(st.pendingDeactivate.length, 0);
  assert.ok(st.keepFailed.length > 0);
});

test("docs mark 206k; no tip-install", () => {
  assert.match(readme, /1\.0\.206k/);
  assert.match(bugs, /1\.0\.206k/);
  assert.match(bugs, /keepFailed|lastFailedNames|cancelDownloadQueue/i);
  assert.match(readme, /No tip-install/);
  assert.match(bugs, /No tip-install/);
});

test("no reopen: 206i–j stack Pause/Cancel / activateQueueIds / Live=Add>0 / Gidugu / soft / modal / Google↔FS / finish", () => {
  assert.match(activateRs, /on_disk_register_gate/);
  assert.match(activateRs, /KNOWN_GDI_SESSION_INCAPABLE/);
  const hard = activateRs.slice(
    activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE"),
    activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE") + 500,
  );
  assert.match(hard, /Gidugu/);
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
  assert.match(activateToggle, /activateQueueIds|catalogMenuRemaining/);
  assert.match(activateToggle, /splitPreferRemainder/);
  assert.match(confirmDlg, /Abort/);
  assert.match(osActivate, /liveCount = activated\.length/);
  assert.doesNotMatch(
    osActivate,
    /Math\.max\(0, skipped, done - failed - settled\)/,
  );
  const start = activateRs.indexOf("pub fn start_google_downloads");
  const body = activateRs.slice(start, start + 2000);
  assert.match(body, /None => continue/);
  assert.doesNotMatch(body, /unwrap_or_else\(\|\| infer_fetch_intent\(family\)\)/);
  // 206j prefix confirm stack
  assert.match(osActivate, /beginRemoveBatch/);
  assert.match(osActivate, /confirmRemovePrefixByDone/);
  assert.match(osActivate, /restoreRemoveRemainderLive/);
});
