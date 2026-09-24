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
const tipH = readFileSync(join(root, "scripts/tip-1.0.206h.test.mjs"), "utf8");
const tipI = readFileSync(join(root, "scripts/tip-1.0.206i.test.mjs"), "utf8");

const HONEST_PREFER = "selected/favorites/visible/first-page/recent";

test("206n keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.207");
  assert.match(version, /1\.0\.207/);
});

test("docs mark 206n; tip hygiene + bulk opt + wall-clock prep/skip; no tip-install", () => {
  assert.match(readme, /1\.0\.206n/);
  assert.match(bugs, /1\.0\.206n/);
  assert.match(bugs, /buckets\.visibleIds|Bulk confirm opt/i);
  assert.match(bugs, /wall-clock|prep\/skip\/prefer/i);
  assert.match(bugs, /never imply FontBase-parallel Add|not FontBase/i);
  assert.match(readme, /No tip-install/);
  assert.match(bugs, /No tip-install/);
  // Historical 1.0.206n section only — compact density later landed 206p (not still-open pack truth).
  {
    const secStart = bugs.indexOf("## Fixed in tip / 1.0.206n");
    assert.ok(secStart >= 0, "1.0.206n Fixed section missing");
    const next = bugs.indexOf("## Fixed in tip /", secStart + 1);
    const sec = bugs.slice(secStart, next < 0 ? undefined : next);
    assert.match(sec, /Deferred \(still\):.*compact density/i);
  }
});

test("tip-206h/i hygiene: assert landed 206l; no soft-deferred session-restore prefer", () => {
  assert.match(tipH, /landed 206l|Landed 1\.0\.206l/i);
  assert.match(tipI, /landed 206l|Landed 1\.0\.206l/i);
  assert.doesNotMatch(tipH, /session restore prefer still deferred/);
  assert.doesNotMatch(tipI, /session restore prefer still deferred/);
  // BUGS progressive restore must not soft-bait as bare Deferred P1.
  assert.match(bugs, /Landed 1\.0\.206l:.*prefer waves/i);
  assert.doesNotMatch(
    bugs,
    /Deferred P1 \(landed 1\.0\.206l\):/,
  );
});

test("bulk confirm reuses buckets.visibleIds (no second visibleFamilySet)", () => {
  const start = activateToggle.indexOf("if (usable.length > 50)");
  assert.ok(start >= 0);
  const body = activateToggle.slice(start, start + 900);
  assert.match(body, /buckets\.visibleIds/);
  assert.doesNotMatch(body, /visibleFamilySet\(\)/);
  assert.doesNotMatch(
    body,
    /const visibleIds = usable\.filter/,
  );
  // preferBuckets still owns the single visibleFamilySet call
  assert.match(activateToggle, /function preferBuckets/);
  const bucketsStart = activateToggle.indexOf("function preferBuckets");
  const buckets = activateToggle.slice(bucketsStart, bucketsStart + 700);
  assert.match(buckets, /visibleFamilySet\(\)/);
});

test("wave0 comment prefer-order matches real order (not scramble)", () => {
  assert.match(
    activateToggle,
    /Wave0: enqueue selected → favorites → viewport → first-page → recent immediately/,
  );
  assert.doesNotMatch(
    activateToggle,
    /Wave0: enqueue visible\/selected\/favorites/,
  );
  assert.match(activateToggle, /selected → favorites → viewport → first-page → recent/);
});

test("chrome honesty: confirm + Activate toast keep full prefer categories", () => {
  assert.match(confirmDlg, new RegExp(HONEST_PREFER.replace(/\//g, "\\/")));
  assert.match(
    activateToggle,
    /Selected\/favorites\/visible\/first-page\/recent first/,
  );
  assert.doesNotMatch(
    confirmDlg,
    /\(visible\/selected\/favorites\/recent\)/,
  );
  assert.doesNotMatch(
    activateToggle,
    /Visible\/favorites\/recent first/,
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
