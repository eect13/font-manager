import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { activateQueueIds } from "../src/lib/fonts/activate-queue.mjs";
import {
  activatePreferIdSet,
  orderPreferKeys,
  PREFER_FIRST_PAGE,
  PREFER_RECENT,
  splitPreferRemainderIds,
} from "../src/lib/fonts/prefer-order.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hydrateTs = readFileSync(join(root, "src/lib/fonts/hydrate.ts"), "utf8");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const preferOrder = readFileSync(join(root, "src/lib/fonts/prefer-order.mjs"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const confirmDlg = readFileSync(
  join(root, "src/components/font-studio/activate-confirm-dialog.tsx"),
  "utf8",
);
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");

test("206l keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("docs mark 206l; favorites+first-page landed; historical compact deferred note; no tip-install", () => {
  assert.match(readme, /1\.0\.206l/);
  assert.match(bugs, /1\.0\.206l/);
  assert.match(bugs, /favorites.*first-page|first-page.*favorites/i);
  assert.match(bugs, /NOT parallel GDI|no parallel.*AddFontResourceEx|prep\/skip/i);
  // Historical 1.0.206l section only — compact density later landed 206p (not still-open pack truth).
  {
    const secStart = bugs.indexOf("## Fixed in tip / 1.0.206l");
    assert.ok(secStart >= 0, "1.0.206l Fixed section missing");
    const next = bugs.indexOf("## Fixed in tip /", secStart + 1);
    const sec = bugs.slice(secStart, next < 0 ? undefined : next);
    assert.match(sec, /Deferred \(still\):.*compact density/i);
  }
  assert.match(readme, /No tip-install/);
  assert.match(bugs, /No tip-install/);
});

test("runtime: restore prefer order — favorites + first-page ahead of bulk remainder", () => {
  const keys = [
    "bulk-zulu",
    "fav-alpha",
    "page-beta",
    "recent-gamma",
    "vis-delta",
    "selected-epsilon",
    "bulk-omega",
  ];
  const ordered = orderPreferKeys(keys, {
    selected: "selected-epsilon",
    favorites: ["fav-alpha"],
    visible: ["vis-delta"],
    firstPage: ["page-beta"],
    recent: ["recent-gamma"],
    caseFold: true,
  });
  assert.deepEqual(ordered.slice(0, 5), [
    "selected-epsilon",
    "fav-alpha",
    "vis-delta",
    "page-beta",
    "recent-gamma",
  ]);
  const favIdx = ordered.indexOf("fav-alpha");
  const pageIdx = ordered.indexOf("page-beta");
  const bulkIdx = Math.min(ordered.indexOf("bulk-zulu"), ordered.indexOf("bulk-omega"));
  assert.ok(favIdx >= 0 && pageIdx >= 0);
  assert.ok(favIdx < bulkIdx, "favorites ahead of bulk");
  assert.ok(pageIdx < bulkIdx, "first-page ahead of bulk");
  assert.equal(PREFER_FIRST_PAGE, 24);
  assert.equal(PREFER_RECENT, 24);
});

test("runtime: Activate prefer set includes favorites; Settled/hard never in queue", () => {
  const ids = ["a", "b", "c", "d", "e", "gidugu-id", "settled-id"];
  const ordered = orderPreferKeys(ids, {
    selected: "a",
    favorites: ["c"],
    visible: ["b"],
    firstPage: ["d"],
    recent: ["e"],
  });
  const { prefer, remainder } = splitPreferRemainderIds(ordered, {
    selectedId: "a",
    favoriteIds: ["c"],
    visibleIds: ["b"],
    firstPageIds: ["d"],
    recentIds: ["e"],
  });
  assert.ok(prefer.includes("c"), "favorites in wave0 prefer");
  assert.ok(prefer.includes("a") && prefer.includes("b"));
  assert.ok(prefer.includes("d"), "first-page in prefer");
  assert.ok(!prefer.includes("gidugu-id"));
  assert.ok(remainder.includes("gidugu-id") || ordered.includes("gidugu-id"));

  const preferSet = activatePreferIdSet(ids, {
    selectedId: "a",
    favoriteIds: ["c", "missing"],
    visibleIds: ["b"],
    firstPageIds: ["d"],
    recentIds: ["e"],
  });
  assert.ok(preferSet.has("c"));
  assert.ok(!preferSet.has("missing"));

  const state = {
    activatedSet: new Set(),
    pendingSet: new Set(),
    pendingDeactivateSet: new Set(),
    settledFamilySet: new Set(["settled face"]),
    localFonts: [],
    googleFonts: [
      { id: "c", family: "Fav", source: "google" },
      { id: "settled-id", family: "Settled Face", source: "google" },
      { id: "gidugu-id", family: "Gidugu", source: "google" },
      { id: "ok", family: "Ok", source: "google" },
    ],
  };
  const usable = activateQueueIds(["c", "settled-id", "gidugu-id", "ok"], state);
  assert.deepEqual(usable, ["c", "ok"]);
  assert.ok(!usable.includes("settled-id"));
  assert.ok(!usable.includes("gidugu-id"));
});

test("hydrate wires prefer-order with favorites + first-page + visible", () => {
  assert.match(hydrateTs, /prefer-order\.mjs/);
  assert.match(hydrateTs, /orderPreferKeys/);
  assert.match(hydrateTs, /PREFER_FIRST_PAGE/);
  assert.match(hydrateTs, /favoriteNames|favorites/);
  assert.match(hydrateTs, /firstPageNames|firstPage/);
  assert.match(hydrateTs, /1\.0\.206l prefer waves/);
  assert.match(hydrateTs, /selected → favorites → viewport/);
});

test("Activate All prefer includes favorites; chunk+yield; no parallel Add path", () => {
  assert.match(activateToggle, /prefer-order\.mjs/);
  assert.match(activateToggle, /orderPreferKeys|splitPreferRemainderIds/);
  assert.match(activateToggle, /favoriteIds:\s*state\.favorites|favorites:\s*state\.favorites/);
  assert.match(activateToggle, /scopeFirstPageIds/);
  assert.match(activateToggle, /ACTIVATE_WAVE|activateInWaves/);
  assert.match(activateToggle, /activateQueueIds/);
  assert.doesNotMatch(activateToggle, /Worker|Atomics|parallelAdd|AddFontResourceEx/);
  assert.match(confirmDlg, /selected\/favorites\/visible\/first-page\/recent/);
});

test("safe throughput docs: prep/skip only — no parallel GDI / FR_PRIVATE / quota raise", () => {
  assert.match(preferOrder, /no parallel AddFontResourceEx|only reorders enqueue/i);
  assert.match(readme, /prep\/skip|prep parallelism|Wall-clock win = prep/i);
  assert.match(readme, /no parallel AddFontResourceEx/i);
  assert.match(activateRs, /AddFontResourceExW|AddFontResourceEx/);
  assert.doesNotMatch(preferOrder, /FR_PRIVATE/);
  assert.doesNotMatch(activateToggle, /FR_PRIVATE|GDI_OBJECT|raise.*quota/i);
});

test("no reopen: 206k stack Cancel/Live/Gidugu/soft/modal/activateQueueIds/Google↔FS", () => {
  assert.match(activateRs, /KNOWN_GDI_SESSION_INCAPABLE/);
  const hardStart = activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE");
  assert.ok(hardStart >= 0);
  const hard = activateRs.slice(hardStart, hardStart + 500);
  assert.match(hard, /Gidugu/);
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
  assert.match(activateToggle, /activateQueueIds|splitPreferRemainder/);
  assert.match(confirmDlg, /Abort/);
  assert.match(osActivate, /restoreRemoveRemainderLive|beginOwnedJob|beginRemoveBatch/);
  assert.match(osActivate, /activated\.length|liveCount/);
  const start = activateRs.indexOf("pub fn start_google_downloads");
  assert.ok(start >= 0);
  const body = activateRs.slice(start, start + 2000);
  assert.match(body, /None => continue/);
  assert.doesNotMatch(body, /unwrap_or_else\(\|\| infer_fetch_intent\(family\)\)/);
});
