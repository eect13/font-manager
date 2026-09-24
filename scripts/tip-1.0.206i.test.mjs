import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  activateQueueIds,
  catalogMenuRemaining,
} from "../src/lib/fonts/activate-queue.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const confirmDlg = readFileSync(
  join(root, "src/components/font-studio/activate-confirm-dialog.tsx"),
  "utf8",
);
const downloadBar = readFileSync(
  join(root, "src/components/font-studio/download-bar.tsx"),
  "utf8",
);
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const activateQueueSrc = readFileSync(
  join(root, "src/lib/fonts/activate-queue.mjs"),
  "utf8",
);
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");

function font(id, family, source = "google") {
  return { id, family, source };
}

function emptyState(over = {}) {
  return {
    activatedSet: new Set(),
    pendingSet: new Set(),
    pendingDeactivateSet: new Set(),
    settledFamilySet: new Set(),
    localFonts: [],
    googleFonts: [],
    ...over,
  };
}

test("206i keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("P1 unload_now wires Pause+Cancel (not soft-lie / not hide-only)", () => {
  const start = activateRs.indexOf("fn unload_now(");
  assert.ok(start >= 0, "unload_now present");
  const body = activateRs.slice(start, start + 4500);
  assert.match(body, /on_disk_register_gate/);
  assert.match(body, /StopCancelled/);
  assert.match(body, /WaitPaused/);
  assert.match(body, /1\.0\.206i/);
  // Fresh remove job clears leftover cancel/pause
  assert.match(activateRs, /Fresh remove job — clear leftover cancel\/pause/);
  // Bar still shows Pause/Cancel on remove (wired, not hidden)
  const barStart = downloadBar.indexOf("{job.running || job.paused ? (");
  const bar = downloadBar.slice(barStart, barStart + 900);
  assert.match(bar, /pauseDownloadQueue/);
  assert.match(bar, /cancelDownloadQueue/);
  assert.doesNotMatch(bar, /job\.mode !== ["']remove["']/);
  assert.match(osActivate, /Cancel stops further Removes/);
});

test("P1 catalogMenuStats.remaining calls shared activateQueueIds path", () => {
  assert.match(activateToggle, /catalogMenuRemaining\(/);
  assert.match(activateToggle, /from "@\/lib\/fonts\/activate-queue\.mjs"/);
  assert.match(activateQueueSrc, /export function activateQueueIds/);
  assert.match(activateQueueSrc, /export function catalogMenuRemaining/);
  assert.match(activateQueueSrc, /pendingDeactivateSet/);
  // No duplicated Settled/hard remaining += 1 loop in catalogMenuStats
  const statsStart = activateToggle.indexOf("function catalogMenuStats(");
  const stats = activateToggle.slice(statsStart, statsStart + 1200);
  assert.match(stats, /catalogMenuRemaining\(fonts, state, filter\)/);
  assert.doesNotMatch(stats, /remaining \+= 1/);
  assert.doesNotMatch(stats, /isKnownGdiSessionIncapable\(font\.family\)/);
});

test("P1 RUNTIME: catalog remaining === activateQueueIds.length on fixture", () => {
  const fonts = [
    font("g:nunito", "Nunito"),
    font("g:gidugu", "Gidugu"),
    font("g:live", "LiveFace"),
    font("g:pending", "PendingFace"),
    font("g:off", "PendingOffFace"),
    font("g:settled", "SettledFace"),
    font("g:sys", "Segoe UI", "system"),
    font("g:ok", "OkFace"),
  ];
  const state = emptyState({
    googleFonts: fonts,
    localFonts: [],
    activatedSet: new Set(["g:live"]),
    pendingSet: new Set(["g:pending"]),
    pendingDeactivateSet: new Set(["g:off"]),
    settledFamilySet: new Set(["settledface"]),
  });
  const ids = fonts.map((f) => f.id);
  const queue = activateQueueIds(ids, state);
  const remaining = catalogMenuRemaining(fonts, state);
  assert.equal(remaining, queue.length);
  assert.deepEqual(queue.sort(), ["g:nunito", "g:ok"].sort());
  // Filter path (Google-only style)
  const onlyOk = catalogMenuRemaining(fonts, state, (f) => f.id === "g:ok" || f.id === "g:gidugu");
  assert.equal(onlyOk, activateQueueIds(["g:ok", "g:gidugu"], state).length);
  assert.equal(onlyOk, 1);
});

test("P1 pendingDeactivate aligned — not counted as remaining", () => {
  const fonts = [font("g:a", "Alpha"), font("g:b", "Beta")];
  const state = emptyState({
    googleFonts: fonts,
    pendingDeactivateSet: new Set(["g:a"]),
  });
  assert.deepEqual(activateQueueIds(["g:a", "g:b"], state), ["g:b"]);
  assert.equal(catalogMenuRemaining(fonts, state), 1);
});

test("docs mark 206i; session restore prefer landed 206l (not soft-deferred)", () => {
  assert.match(readme, /1\.0\.206i/);
  assert.match(bugs, /1\.0\.206i/);
  assert.match(bugs, /unload_now.*honor|honor.*Pause|Pause\+Cancel/i);
  assert.match(bugs, /catalogMenuRemaining|catalogMenuStats\.remaining/i);
  // 1.0.206n hygiene: assert landed, not soft-pass on "Deferred P1 (landed …)" wording.
  assert.match(bugs, /session restore prefer landed 206l|Landed 1\.0\.206l.*prefer waves/i);
  assert.doesNotMatch(
    bugs,
    /Deferred \(still\): session restore prefer visible\/favorites\/first-page/,
  );
});

test("no reopen: Live=Add>0 / Gidugu-hard / Soft Retry / modal wave0 / Google↔FS / finish toast", () => {
  assert.match(activateRs, /KNOWN_GDI_SESSION_INCAPABLE/);
  const hard = activateRs.slice(
    activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE"),
    activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE") + 500,
  );
  assert.match(hard, /Gidugu/);
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
  assert.match(activateRs, /\.settled-add-zero/);
  assert.match(activateToggle, /splitPreferRemainder/);
  assert.match(confirmDlg, /Abort/);
  assert.match(osActivate, /liveCount = activated\.length/);
  assert.doesNotMatch(
    osActivate,
    /Math\.max\(0, skipped, done - failed - settled\)/,
  );
  // 206h no-infer kept
  const start = activateRs.indexOf("pub fn start_google_downloads");
  const body = activateRs.slice(start, start + 2000);
  assert.match(body, /None => continue/);
  assert.doesNotMatch(body, /unwrap_or_else\(\|\| infer_fetch_intent\(family\)\)/);
});
