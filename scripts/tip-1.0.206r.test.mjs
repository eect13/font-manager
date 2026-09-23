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
const styles = readFileSync(join(root, "src/styles.css"), "utf8");
const dialogUi = readFileSync(join(root, "src/components/ui/dialog.tsx"), "utf8");
const sheetUi = readFileSync(join(root, "src/components/ui/sheet.tsx"), "utf8");
const libraryGrid = readFileSync(
  join(root, "src/components/font-studio/library-grid.tsx"),
  "utf8",
);
const glyphMap = readFileSync(
  join(root, "src/components/font-studio/glyph-map.tsx"),
  "utf8",
);
const desktopSettings = readFileSync(
  join(root, "src/components/font-studio/desktop-settings.tsx"),
  "utf8",
);
const activateConfirm = readFileSync(
  join(root, "src/components/font-studio/activate-confirm-dialog.tsx"),
  "utf8",
);
const collectionDlg = readFileSync(
  join(root, "src/components/font-studio/collection-dialog.tsx"),
  "utf8",
);
const uploadsReset = readFileSync(
  join(root, "src/components/font-studio/uploads-reset-dialog.tsx"),
  "utf8",
);
const folderTree = readFileSync(
  join(root, "src/components/font-studio/folder-tree.tsx"),
  "utf8",
);
const uiDensity = readFileSync(join(root, "src/lib/ui-density.ts"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
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

function blockVars(label) {
  const re =
    label === "comfortable"
      ? /:root,\s*:root\[data-ui-density="comfortable"\]\s*\{([^}]+)\}/
      : /:root\[data-ui-density="compact"\]\s*\{([^}]+)\}/;
  const m = styles.match(re);
  assert.ok(m, `${label} density block missing`);
  const out = {};
  for (const line of m[1].split(";")) {
    const kv = line.trim().match(/^(--fm-[\w-]+)\s*:\s*([^;]+)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function remToNum(v) {
  const m = String(v).trim().match(/^([\d.]+)rem$/);
  assert.ok(m, `expected rem value, got ${v}`);
  return Number(m[1]);
}

test("206r keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
  const tauri = JSON.parse(
    readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  assert.equal(tauri.version, "1.0.206");
});

test("docs mark 206r Fixed; primary+secondary; no tip-install; no everywhere overclaim", () => {
  assert.match(readme, /1\.0\.206r/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206r/);
  assert.match(bugs, /dialogs|empty|settings/i);
  assert.match(bugs, /primary \+ secondary|primary \+ secondary chrome/i);
  assert.match(readme, /No tip-install/);
  assert.match(bugs, /No tip-install/);
  const rStart = bugs.indexOf("## Fixed in tip / 1.0.206r");
  assert.ok(rStart >= 0);
  const rSec = bugs.slice(rStart, bugs.indexOf("## Fixed in tip / 1.0.206q"));
  assert.doesNotMatch(rSec, /tip-install(?!\/pack)|APPROVE FOR PACK/i);
  // No bare "everywhere" as still-true claim in 206r section
  assert.doesNotMatch(rSec, /tightens \*\*everywhere\*\*|density everywhere/i);
  assert.match(rSec, /toasts|chips|pickers/i);
});

test("persist key font-manager:ui-density unchanged", () => {
  assert.match(uiDensity, /font-manager:ui-density/);
  assert.match(uiDensity, /data-ui-density/);
  assert.match(desktopSettings, /useUiDensity/);
});

test("density CSS vars — Compact < Comfortable for dialog/empty/settings", () => {
  const keys = [
    "--fm-dialog-pad",
    "--fm-dialog-gap",
    "--fm-dialog-header-mb",
    "--fm-sheet-pad",
    "--fm-empty-py",
    "--fm-empty-px",
    "--fm-settings-pad",
    "--fm-settings-gap",
    "--fm-settings-row-py",
  ];
  const comfort = blockVars("comfortable");
  const compact = blockVars("compact");
  for (const key of keys) {
    assert.ok(comfort[key], `comfortable missing ${key}`);
    assert.ok(compact[key], `compact missing ${key}`);
    assert.notEqual(
      comfort[key],
      compact[key],
      `${key} must differ Compact vs Comfortable`,
    );
    assert.ok(
      remToNum(compact[key]) < remToNum(comfort[key]),
      `${key}: Compact (${compact[key]}) must be < Comfortable (${comfort[key]})`,
    );
  }
  // Classes present
  assert.match(styles, /\.fm-dialog-content/);
  assert.match(styles, /\.fm-dialog-header/);
  assert.match(styles, /\.fm-dialog-footer/);
  assert.match(styles, /\.fm-dialog-body/);
  assert.match(styles, /\.fm-sheet-header/);
  assert.match(styles, /\.fm-empty-pane/);
  assert.match(styles, /\.fm-settings-stack/);
  assert.match(styles, /\.fm-settings-row/);
  assert.match(styles, /\.fm-settings-opts/);
});

test("dialog / sheet / empty / settings sources reference density classes", () => {
  assert.match(dialogUi, /fm-dialog-content/);
  assert.match(dialogUi, /fm-dialog-header/);
  assert.doesNotMatch(dialogUi, /\bp-6\b/);
  assert.match(sheetUi, /fm-sheet-header/);
  assert.doesNotMatch(sheetUi, /\bp-5 pr-12\b/);
  assert.match(libraryGrid, /fm-empty-pane/);
  assert.doesNotMatch(libraryGrid, /px-6 py-20/);
  assert.match(glyphMap, /fm-empty-pane/);
  assert.doesNotMatch(glyphMap, /px-6 py-20/);
  assert.match(desktopSettings, /fm-settings-row/);
  assert.match(desktopSettings, /fm-settings-stack|fm-settings-opts/);
  assert.doesNotMatch(desktopSettings, /px-3 py-2\.5/);
  assert.match(activateConfirm, /fm-dialog-footer/);
  assert.match(collectionDlg, /fm-dialog-body/);
  assert.match(collectionDlg, /fm-dialog-footer/);
  assert.match(uploadsReset, /fm-dialog-footer/);
  assert.match(folderTree, /fm-dialog-footer/);
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
  // Progressive path preserved
  assert.match(osActivate, /confirmRemoveUnloaded\(p\.ready_names/);
  assert.match(osActivate, /confirmRemoveUnloaded/);
  assert.match(osActivate, /remove ready_names = unloaded prefix|Not all at spawn/);
  // Web preview confirmDeactivated(all) when !inDesktopShell is OK — must remain gated
  const syncStart = osActivate.indexOf("export async function syncFontsOnSystem");
  assert.ok(syncStart >= 0);
  const syncHead = osActivate.slice(syncStart, syncStart + 900);
  assert.match(syncHead, /if \(!\(await inDesktopShell\(\)\)\)/);
  assert.match(syncHead, /confirmDeactivated\(fonts\.map/);
});

test("HARD LOCK: Cancel Deactivate honesty — restore Live; no all-stay-Live soft-lie", () => {
  assert.match(osActivate, /restoreRemoveRemainderLive/);
  assert.match(osActivate, /confirmRemovePrefixByDone|confirmRemoveUnloaded/);
  assert.match(osActivate, /remaining stay Live/);
  assert.match(osActivate, /liveRemain > 0/);
  assert.match(osActivate, /No Removes finished — Live unchanged/);
  assert.match(
    osActivate,
    /Toast must match store \(no "stay Live" if already confirmDeactivated-all at spawn\)/,
  );
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

test("density-only scope honesty: no tip-install/pack claim; activate paths not 'simplified' away", () => {
  assert.match(bugs, /density-only|Density-only/i);
  // Comments that guard Off-at-spawn must remain (density tip must not delete them)
  assert.match(osActivate, /Do NOT confirm all Off here/);
  assert.match(osActivate, /Not all at spawn/);
});
