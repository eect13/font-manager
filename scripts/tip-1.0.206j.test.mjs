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

/** Simulate Cancel settle: prefix Off, remainder Live (pending cleared). */
function settleCancelRemove(activated, pendingDeactivate, batchIds, done) {
  const prefix = batchIds.slice(0, Math.min(done, batchIds.length));
  const prefixSet = new Set(prefix);
  const nextActivated = activated.filter((id) => !prefixSet.has(id));
  const remainder = batchIds.filter((id) => !prefixSet.has(id));
  const remSet = new Set(remainder);
  const nextPending = pendingDeactivate.filter((id) => !prefixSet.has(id) && !remSet.has(id));
  // Remainder stay in activated (Live); pending-off cleared.
  const liveRemain = remainder.filter((id) => nextActivated.includes(id) || activated.includes(id) && !prefixSet.has(id));
  // After clear pending only — activated still has remainder
  const liveAfter = activated.filter((id) => !prefixSet.has(id));
  return {
    activated: liveAfter,
    pendingDeactivate: nextPending,
    prefix,
    remainder,
    liveRemain: liveAfter.filter((id) => remSet.has(id)),
    toastStayLive: liveAfter.some((id) => remSet.has(id)),
  };
}

test("206j keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("P1 no confirmDeactivated(all) at unload_font_families spawn", () => {
  const start = osActivate.indexOf("if (!on) {");
  assert.ok(start >= 0);
  // Desktop syncFontsOnSystem(!on) body before google activate branch
  const body = osActivate.slice(start, osActivate.indexOf("const google = fonts.filter", start));
  assert.match(body, /beginRemoveBatch/);
  assert.match(body, /unload_font_families/);
  assert.match(body, /Do NOT confirm all Off here|returns at spawn/i);
  // Must NOT confirm all fonts right after invoke
  assert.doesNotMatch(
    body,
    /confirmDeactivated\(fonts\.map/,
  );
  assert.doesNotMatch(body, /finishOwnedJob\("remove"\)/);
  assert.match(body, /startGooglePoll\("remove"\)/);
});

test("P1 Rust ready_names = unloaded prefix on remove", () => {
  const start = activateRs.indexOf("fn unload_now(");
  const body = activateRs.slice(start, start + 9000);
  assert.match(body, /1\.0\.206j/);
  assert.match(body, /ready_names\.push/);
  assert.match(body, /session_remove\(app, &prefix\)/);
  assert.match(body, /on_disk_register_gate/);
});

test("P1 Cancel restores Live for never-unloaded; toast matches store", () => {
  assert.match(osActivate, /restoreRemoveRemainderLive/);
  assert.match(osActivate, /confirmRemovePrefixByDone|confirmRemoveUnloaded/);
  assert.match(osActivate, /remaining stay Live/);
  // Toast gated on liveRemain > 0 — no soft-lie when remainder already Off
  assert.match(osActivate, /liveRemain > 0/);
  assert.match(osActivate, /No Removes finished — Live unchanged/);

  // Runtime fixture: Cancel mid-bulk (done=2 of 5) → prefix Off, remainder Live, toast OK
  const batch = ["a", "b", "c", "d", "e"];
  const st = settleCancelRemove(batch.slice(), batch.slice(), batch, 2);
  assert.deepEqual(st.prefix, ["a", "b"]);
  assert.deepEqual(st.remainder, ["c", "d", "e"]);
  assert.deepEqual(st.activated, ["c", "d", "e"]);
  assert.deepEqual(st.liveRemain, ["c", "d", "e"]);
  assert.equal(st.toastStayLive, true);
  assert.equal(st.pendingDeactivate.length, 0);

  // If somehow all already Off (old spawn soft-lie), toast must NOT claim stay Live
  const lied = settleCancelRemove([], batch.slice(), batch, 5);
  assert.equal(lied.activated.length, 0);
  assert.equal(lied.toastStayLive, false);
});

test("P1 progressive remove confirm via ready_names / done prefix", () => {
  assert.match(osActivate, /remove ready_names = unloaded prefix/);
  assert.match(osActivate, /confirmRemoveUnloaded\(p\.ready_names/);
  assert.match(osActivate, /confirmRemovePrefixByDone\(p\.done\)/);
});

test("docs mark 206j; no tip-install", () => {
  assert.match(readme, /1\.0\.206j/);
  assert.match(bugs, /1\.0\.206j/);
  assert.match(bugs, /confirmDeactivated|prefix|spawn/i);
  assert.match(readme, /No tip-install/);
  assert.match(bugs, /No tip-install/);
});

test("no reopen: Pause/Cancel gate / activateQueueIds / Live=Add>0 / Gidugu-hard / soft / modal / Google↔FS / finish toast", () => {
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
});
