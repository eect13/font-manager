import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { activateQueueIds } from "../src/lib/fonts/activate-queue.mjs";
import {
  isKnownGdiSessionIncapable,
  KNOWN_GDI_SESSION_INCAPABLE,
} from "../src/lib/fonts/gdi-incapable.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktopSettings = readFileSync(
  join(root, "src/components/font-studio/desktop-settings.tsx"),
  "utf8",
);
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const downloadBar = readFileSync(
  join(root, "src/components/font-studio/download-bar.tsx"),
  "utf8",
);
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const activateQueueSrc = readFileSync(
  join(root, "src/lib/fonts/activate-queue.mjs"),
  "utf8",
);
const gdiMirror = readFileSync(join(root, "src/lib/fonts/gdi-incapable.ts"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");

test("206s keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.207");
  assert.match(version, /1\.0\.207/);
  const tauri = JSON.parse(
    readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  assert.equal(tauri.version, "1.0.207");
});

test("docs mark 206s Fixed; UIA smoke hooks; no tip-install/pack", () => {
  assert.match(readme, /1\.0\.206s/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206s/);
  assert.match(bugs, /UIA|aria-label|data-testid/i);
  assert.match(readme, /No tip-install/);
  assert.match(bugs, /No tip-install/);
  const sStart = bugs.indexOf("## Fixed in tip / 1.0.206s");
  assert.ok(sStart >= 0);
  const sSec = bugs.slice(sStart, bugs.indexOf("## Fixed in tip / 1.0.206r"));
  assert.doesNotMatch(sSec, /tip-install(?!\/pack)|APPROVE FOR PACK/i);
  assert.match(sSec, /Settings|density|Activate All|Deactivate All|Pause|Cancel/i);
});

test("Settings gear: stable aria-label Settings + data-testid settings-open", () => {
  assert.match(desktopSettings, /aria-label="Settings"/);
  assert.match(desktopSettings, /data-testid="settings-open"/);
  assert.doesNotMatch(desktopSettings, /aria-label="Desktop settings"/);
});

test("Density buttons: Comfortable/Compact aria-label + density-* testids", () => {
  assert.match(desktopSettings, /aria-label=\{opt\.label\}/);
  assert.match(desktopSettings, /data-testid=\{`density-\$\{opt\.id\}`\}/);
  assert.match(desktopSettings, /aria-pressed=\{density === opt\.id\}/);
  assert.match(desktopSettings, /title=\{opt\.hint\}/);
  assert.match(desktopSettings, /onClick=\{\(\) => setDensity\(opt\.id\)\}/);
  assert.match(desktopSettings, /label: "Comfortable"/);
  assert.match(desktopSettings, /label: "Compact"/);
  assert.match(desktopSettings, /id: "comfortable"/);
  assert.match(desktopSettings, /id: "compact"/);
});

test("Activate All menu items: aria-label Activate All + data-testid activate-all", () => {
  // 1.0.206u: aria-label may be dynamic (Activate remaining); require testid + Activate All string.
  const activateAll = [...activateToggle.matchAll(/data-testid="activate-all"/g)];
  // ActivateMenuItem, CatalogActivateMenuItem, LibraryActivateMenuItem
  assert.equal(activateAll.length, 3, `expected 3 activate-all testids, got ${activateAll.length}`);
  assert.match(activateToggle, /Activate All/);
  // Visible text may stay dynamic
  assert.match(activateToggle, /Activate remaining/);
  assert.match(activateToggle, /"Activate all"/);
});

test("Deactivate All menu items: aria-label Deactivate All + data-testid deactivate-all", () => {
  const deactivateAll = [
    ...activateToggle.matchAll(
      /aria-label="Deactivate All"[\s\S]*?data-testid="deactivate-all"/g,
    ),
  ];
  // DeactivateMenuItem, Catalog, Library, ActivatedDeactivateMenuItem
  assert.equal(
    deactivateAll.length,
    4,
    `expected 4 Deactivate All hooks, got ${deactivateAll.length}`,
  );
});

test("Download bar Pause/Cancel (+Resume) stable UIA hooks", () => {
  assert.match(downloadBar, /aria-label="Pause"/);
  assert.match(downloadBar, /data-testid="activate-bar-pause"/);
  assert.match(downloadBar, /aria-label=\{docsChrome \? "Cancel Documents refresh" : restoring \? "Cancel session restore" : "Cancel"\}/);
  assert.match(downloadBar, /data-testid="activate-bar-cancel"/);
  assert.match(downloadBar, /aria-label="Resume"/);
  assert.match(downloadBar, /data-testid="activate-bar-resume"/);
});

test("a11y-only scope: activateSet / queue / Settled skip untouched", () => {
  assert.match(activateToggle, /export function activateSet/);
  assert.match(activateToggle, /activateQueueIds\(ids, state\)/);
  assert.match(activateToggle, /Already Live, pending, or Settled/);
  assert.match(activateToggle, /void activateInWaves/);
  // No honesty behavior change markers deleted
  assert.match(activateToggle, /1\.0\.205 P0 \/ 1\.0\.206i: skip Settled/);
});

test("HARD LOCK: no Deactivate-all-at-once (UI Off at spawn) — 206j progressive", () => {
  const start = osActivate.indexOf("if (!on) {");
  assert.ok(start >= 0);
  const body = osActivate.slice(
    start,
    osActivate.indexOf("const google = fonts.filter", start),
  );
  assert.match(body, /Do NOT confirm all Off here/);
  assert.match(body, /Not all at spawn|returns at spawn/i);
  assert.match(body, /unload_font_families/);
  assert.match(body, /beginRemoveBatch/);
  assert.match(body, /startGooglePoll\("remove"\)/);
  assert.doesNotMatch(body, /confirmDeactivated\(fonts\.map/);
  assert.match(osActivate, /confirmRemoveUnloaded\(p\.ready_names/);
  assert.match(osActivate, /confirmRemoveUnloaded/);
});

test("HARD LOCK: Cancel Deactivate honesty — restore Live", () => {
  assert.match(osActivate, /restoreRemoveRemainderLive/);
  assert.match(osActivate, /confirmRemovePrefixByDone|confirmRemoveUnloaded/);
  assert.match(osActivate, /remaining stay Live/);
  assert.match(osActivate, /liveRemain > 0/);
});

test("standing locks: Live=Add>0 / Settled / Gidugu-hard / soft emoji / Google↔FS / no parallel Add", () => {
  assert.match(activateRs, /KNOWN_GDI_SESSION_INCAPABLE/);
  const hardStart = activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE");
  assert.ok(hardStart >= 0);
  const hard = activateRs.slice(hardStart, hardStart + 500);
  assert.match(hard, /Gidugu/);
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
  assert.match(gdiMirror, /SOFT_GDI_TRY_ADD_FIRST/);
  assert.match(activateRs, /\.settled-add-zero/);
  assert.doesNotMatch(activateToggle, /Worker|Atomics|parallelAdd|FR_PRIVATE/);
  assert.doesNotMatch(activateQueueSrc, /FR_PRIVATE/);
  const start = activateRs.indexOf("pub fn start_google_downloads");
  assert.ok(start >= 0);
  const body = activateRs.slice(start, start + 2000);
  assert.match(body, /None => continue/);
  assert.doesNotMatch(body, /unwrap_or_else\(\|\| infer_fetch_intent\(family\)\)/);
  assert.equal(KNOWN_GDI_SESSION_INCAPABLE.length, 1);
  assert.equal(KNOWN_GDI_SESSION_INCAPABLE[0].family, "Gidugu");
  assert.equal(isKnownGdiSessionIncapable("Gidugu"), true);
  assert.equal(isKnownGdiSessionIncapable("Noto Color Emoji"), false);
  const state = {
    activatedSet: new Set(),
    pendingSet: new Set(),
    pendingDeactivateSet: new Set(),
    settledFamilySet: new Set(),
    localFonts: [],
    googleFonts: [
      { id: "g1", family: "Gidugu", source: "google" },
      { id: "e1", family: "Noto Color Emoji", source: "google" },
      { id: "n1", family: "Nunito", source: "google" },
    ],
  };
  assert.deepEqual(activateQueueIds(["g1", "e1", "n1"], state), ["e1", "n1"]);
});

test("206q honesty kept: Pause toast done/total + ActivateVisible → activateQueueIds", () => {
  const start = osActivate.indexOf("export function pauseDownloadQueue");
  assert.ok(start >= 0);
  const body = osActivate.slice(start, start + 700);
  assert.match(body, /toast\.message\("Paused"/);
  assert.doesNotMatch(body, /Math\.max\(\s*job\.done\s*,\s*job\.skipped\s*\)/);
  assert.match(
    body,
    /Math\.round\(\(100 \* job\.done\) \/ Math\.max\(1, job\.total\)\)/,
  );
  const av = activateToggle.indexOf("export function ActivateVisibleMenuItem");
  assert.ok(av >= 0);
  const next = activateToggle.indexOf("\nexport function ", av + 1);
  const avBody = activateToggle.slice(av, next < 0 ? undefined : next);
  assert.match(avBody, /activateQueueIds\(ids,\s*s\)/);
});
