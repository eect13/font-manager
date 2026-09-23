import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const confirmDlg = readFileSync(
  join(root, "src/components/font-studio/activate-confirm-dialog.tsx"),
  "utf8",
);
const preferOrder = readFileSync(join(root, "src/lib/fonts/prefer-order.mjs"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");

const HONEST_PREFER = "selected/favorites/visible/first-page/recent";

test("206o keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("docs mark 206o; Cancel-label buckets + 206l prefer align; no tip-install", () => {
  assert.match(readme, /1\.0\.206o/);
  assert.match(bugs, /1\.0\.206o/);
  assert.match(bugs, /Cancel-label preferBuckets|orderActivateIds\(visibleIds,\s*state,\s*buckets\)/i);
  assert.match(readme, /orderActivateIds\(visibleIds,\s*state,\s*buckets\)/);
  assert.match(readme, /No tip-install/);
  assert.match(bugs, /No tip-install/);
  assert.match(bugs, /Deferred \(still\):.*compact density/i);
});

test("Cancel-label reuses buckets (no second preferBuckets when visibleIds>0)", () => {
  const start = activateToggle.indexOf("if (usable.length > 50)");
  assert.ok(start >= 0);
  const body = activateToggle.slice(start, start + 1200);
  assert.match(body, /buckets\.visibleIds/);
  // P3: visible path must pass buckets — not bare orderActivateIds(visibleIds, state)
  assert.match(
    body,
    /orderActivateIds\(\s*visibleIds,\s*state,\s*buckets\s*\)/,
  );
  assert.doesNotMatch(
    body,
    /orderActivateIds\(\s*visibleIds,\s*state\s*\)/,
  );
  // Still only one preferBuckets call site for Activate All (shared into order + split + cancel)
  const preferCalls = [
    ...activateToggle.matchAll(/preferBuckets\(usable,\s*state\)/g),
  ];
  assert.equal(preferCalls.length, 1);
  // Bulk confirm body itself must not call preferBuckets or visibleFamilySet
  assert.doesNotMatch(body, /preferBuckets\(/);
  assert.doesNotMatch(body, /visibleFamilySet\(\)/);
});

test("README 206l prefer membership aligned (not scramble-list)", () => {
  // Historical 206l blurb must use ordered arrows, not “visible + selected + …”
  const lStart = readme.indexOf("**1.0.206l");
  assert.ok(lStart >= 0);
  const lBlurb = readme.slice(lStart, lStart + 900);
  assert.match(
    lBlurb,
    /selected → favorites → viewport → first-page → recent/,
  );
  assert.doesNotMatch(
    lBlurb,
    /visible \+ selected \+ favorites/,
  );
});

test("wave0 comment prefer-order matches real order (kept from 206n)", () => {
  assert.match(
    activateToggle,
    /Wave0: enqueue selected → favorites → viewport → first-page → recent immediately/,
  );
  assert.match(activateToggle, /selected → favorites → viewport → first-page → recent/);
});

test("chrome honesty: confirm + Activate toast keep full prefer categories", () => {
  assert.match(confirmDlg, new RegExp(HONEST_PREFER.replace(/\//g, "\\/")));
  assert.match(
    activateToggle,
    /Selected\/favorites\/visible\/first-page\/recent first/,
  );
});

test("standing locks: Live=Add>0 / Gidugu-hard / no parallel Add / Google↔FS / Cancel wasRemove", () => {
  assert.match(activateRs, /KNOWN_GDI_SESSION_INCAPABLE/);
  const hardStart = activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE");
  assert.ok(hardStart >= 0);
  const hard = activateRs.slice(hardStart, hardStart + 500);
  assert.match(hard, /Gidugu/);
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
  assert.match(activateRs, /\.settled-add-zero/);
  assert.match(activateToggle, /splitPreferRemainder|preferBuckets/);
  assert.doesNotMatch(activateToggle, /Worker|Atomics|parallelAdd|FR_PRIVATE/);
  assert.doesNotMatch(preferOrder, /FR_PRIVATE/);
  assert.match(preferOrder, /no parallel AddFontResourceEx|only reorders enqueue/i);
  assert.match(confirmDlg, /Abort/);
  assert.match(osActivate, /restoreRemoveRemainderLive|wasRemove/);
  assert.match(osActivate, /liveCount = activated\.length|activated\.length/);
  const start = activateRs.indexOf("pub fn start_google_downloads");
  assert.ok(start >= 0);
  const body = activateRs.slice(start, start + 2000);
  assert.match(body, /None => continue/);
  assert.doesNotMatch(body, /unwrap_or_else\(\|\| infer_fetch_intent\(family\)\)/);
});
