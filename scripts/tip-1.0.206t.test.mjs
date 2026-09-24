import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { activateQueueIds } from "../src/lib/fonts/activate-queue.mjs";
import {
  isKnownGdiSessionIncapable,
  KNOWN_GDI_SESSION_INCAPABLE,
} from "../src/lib/fonts/gdi-incapable.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
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
const beforeBuild = readFileSync(join(root, "scripts/tauri-before-build.mjs"), "utf8");
const writeTipSha = readFileSync(join(root, "scripts/write-tip-sha.mjs"), "utf8");

function activateVisibleBody() {
  const av = activateToggle.indexOf("export function ActivateVisibleMenuItem");
  assert.ok(av >= 0, "ActivateVisibleMenuItem missing");
  const next = activateToggle.indexOf("\nexport function ", av + 1);
  return activateToggle.slice(av, next < 0 ? undefined : next);
}

test("206t keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.207");
  assert.match(version, /1\.0\.207/);
  const tauri = JSON.parse(
    readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  assert.equal(tauri.version, "1.0.207");
});

test("docs mark 206t Fixed; React #185; tip-sha stamp; no tip-install/pack", () => {
  assert.match(readme, /1\.0\.206t/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206t/);
  assert.match(bugs, /#185|Maximum update depth|max update depth/i);
  assert.match(bugs, /ActivateVisibleMenuItem|primitive count|useShallow/i);
  assert.match(readme, /No tip-install/);
  assert.match(bugs, /No tip-install/);
  const tStart = bugs.indexOf("## Fixed in tip / 1.0.206t");
  assert.ok(tStart >= 0);
  const tSec = bugs.slice(tStart, bugs.indexOf("## Fixed in tip / 1.0.206s"));
  // Same pattern as 206s: allow "No tip-install/pack", reject bare tip-install / pack approve.
  assert.doesNotMatch(tSec, /tip-install(?!\/pack)|APPROVE FOR PACK/i);
  assert.match(tSec, /TIP_SHA|write-tip-sha|provenance/i);
});

test("P0 #185: ActivateVisibleMenuItem must not return out/[] from useFontStore without useShallow", () => {
  const body = activateVisibleBody();
  assert.doesNotMatch(
    body,
    /useFontStore\(\s*\(?\s*s\s*\)?\s*=>\s*\{[\s\S]*?\bconst out\s*=\s*\[\s*\][\s\S]*?return out/,
    "must not return fresh out[] from useFontStore selector",
  );
  assert.doesNotMatch(
    body,
    /useFontStore\(\s*\(?\s*s\s*\)?\s*=>\s*\[/,
    "must not return array literal from useFontStore selector",
  );
  const primitiveCount = /const visibleCount = useFontStore\(/.test(body);
  const shallowOk = /useFontStore\(\s*useShallow\(/.test(body);
  assert.ok(
    primitiveCount || shallowOk,
    "ActivateVisibleMenuItem must subscribe via primitive count or useShallow",
  );
  if (primitiveCount) {
    assert.match(body, /let n = 0/);
    assert.match(body, /return n/);
  }
  assert.match(
    body,
    /onSelect=\{\(\) => activateSet\(resolveVisibleActivateIds\(ids\)/,
  );
  assert.match(activateToggle, /function resolveVisibleActivateIds/);
});

test("206q honesty kept: ActivateVisible → activateQueueIds", () => {
  const body = activateVisibleBody();
  assert.match(body, /activateQueueIds\(ids,\s*s\)/);
  const helperStart = activateToggle.indexOf("function resolveVisibleActivateIds");
  assert.ok(helperStart >= 0);
  const helper = activateToggle.slice(
    helperStart,
    activateToggle.indexOf("export function ActivateVisibleMenuItem"),
  );
  assert.match(helper, /activateQueueIds\(ids,\s*s\)/);
});

test("LibraryActivateMenuItem: Catalog-style array-root useShallow (no nested libraryIds-in-object)", () => {
  const start = activateToggle.indexOf("export function LibraryActivateMenuItem");
  assert.ok(start >= 0);
  const next = activateToggle.indexOf("\nexport function ", start + 1);
  const body = activateToggle.slice(start, next < 0 ? undefined : next);
  assert.doesNotMatch(
    body,
    /ids=\{\[\s*\.\.\.useFontStore\.getState\(\)/,
    "must not rebuild ids={[...getState()...]} each render",
  );
  // P0 Skye 7.2: must NOT nest fresh libraryIds[] inside a shallow object
  // (useShallow Object.is on nested array always false → #185).
  assert.doesNotMatch(
    body,
    /useShallow\(\s*\(?\s*s\s*\)?\s*=>\s*\{[\s\S]*?libraryIds[\s\S]*?return\s*\{/,
    "must not nest libraryIds inside useShallow object return",
  );
  assert.doesNotMatch(
    body,
    /return\s*\{[\s\S]*?libraryIds[\s\S]*?\}/,
    "must not return { ..., libraryIds } from Library selector",
  );
  // Catalog-style: array is the useShallow root snapshot
  assert.match(
    body,
    /const libraryIds = useFontStore\(\s*useShallow\(\s*\(?\s*s\s*\)?\s*=>\s*\[/,
    "libraryIds must be useFontStore(useShallow(s => [...])) array root",
  );
  // Primitives via separate useFontStore selectors (not nested in shallow object)
  assert.match(body, /const count = useFontStore\(/);
  assert.match(body, /const remaining = useFontStore\(/);
  assert.match(body, /const anyOn = useFontStore\(/);
  assert.match(body, /<ActivateVisibleMenuItem ids=\{libraryIds\}/);
  // 1.0.206u: aria may be dynamic (Activate remaining) — still must expose Activate All string + testid.
  assert.match(body, /Activate All/);
  assert.match(body, /data-testid="activate-all"/);
  assert.match(body, /aria-label="Deactivate All"/);
  assert.match(body, /data-testid="deactivate-all"/);
});

test("CatalogActivateMenuItem: stable catalogIds via useShallow (no ids() each render)", () => {
  const start = activateToggle.indexOf("function CatalogActivateMenuItem");
  assert.ok(start >= 0);
  const next = activateToggle.indexOf("\nexport function LibraryActivateMenuItem");
  const body = activateToggle.slice(start, next);
  assert.doesNotMatch(body, /function ids\(\)/);
  assert.doesNotMatch(body, /ids=\{ids\(\)\}/);
  assert.match(body, /const catalogIds = useFontStore\(\s*useShallow/);
  assert.match(body, /<ActivateVisibleMenuItem ids=\{catalogIds\}/);
});

test("206s UIA smoke hooks still present (a11y not regressed)", () => {
  // 1.0.206u: aria-label may be expression (Activate remaining vs Activate All); count testids.
  const activateAll = [...activateToggle.matchAll(/data-testid="activate-all"/g)];
  assert.equal(activateAll.length, 3, `expected 3 activate-all testids, got ${activateAll.length}`);
  assert.match(activateToggle, /Activate All/);
  const deactivateAll = [
    ...activateToggle.matchAll(
      /aria-label="Deactivate All"[\s\S]*?data-testid="deactivate-all"/g,
    ),
  ];
  assert.equal(
    deactivateAll.length,
    4,
    `expected 4 Deactivate All hooks, got ${deactivateAll.length}`,
  );
});

test("tip-install provenance: write-tip-sha.mjs + before-build stamp", () => {
  assert.ok(existsSync(join(root, "scripts/write-tip-sha.mjs")));
  assert.match(writeTipSha, /TIP_SHA\.txt/);
  assert.match(writeTipSha, /rev-parse/);
  assert.match(beforeBuild, /write-tip-sha\.mjs/);
  assert.match(beforeBuild, /TIP_SHA/);
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
  assert.doesNotMatch(body, /confirmDeactivated\(fonts\.map/);
  assert.match(osActivate, /confirmRemoveUnloaded/);
});

test("standing locks: Live=Add>0 / Settled / Gidugu-hard / soft emoji / no parallel Add", () => {
  assert.match(activateRs, /KNOWN_GDI_SESSION_INCAPABLE/);
  const hardStart = activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE");
  assert.ok(hardStart >= 0);
  const hard = activateRs.slice(hardStart, hardStart + 500);
  assert.match(hard, /Gidugu/);
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
  assert.match(gdiMirror, /SOFT_GDI_TRY_ADD_FIRST/);
  assert.doesNotMatch(activateToggle, /Worker|Atomics|parallelAdd|FR_PRIVATE/);
  assert.doesNotMatch(activateQueueSrc, /FR_PRIVATE/);
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
