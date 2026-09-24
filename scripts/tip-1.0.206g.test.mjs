import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const gdiPurge = readFileSync(
  join(root, "scripts/gdi-incapable-no-fs-download-purge.test.mjs"),
  "utf8",
);
const barClear = readFileSync(join(root, "scripts/settled-idle-bar-clear.test.mjs"), "utf8");
const confirmDlg = readFileSync(
  join(root, "src/components/font-studio/activate-confirm-dialog.tsx"),
  "utf8",
);
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");

test("206g keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.207");
  assert.match(version, /1\.0\.207/);
});

test("P2 race: soft Retry sets pending before/with Settled-drop around clearSessionGdiRefused", () => {
  const toggleStart = store.indexOf("toggleActivated: (id) =>");
  const body = store.slice(toggleStart, toggleStart + 3200);
  assert.match(body, /softSettledRetryTried/);
  assert.match(body, /await clearSessionGdiRefused\(font\.family\)/);
  assert.match(body, /withPending\(\[\.\.\.s\.pendingActivate, id\]\)/);
  assert.match(body, /withSettled\(s\.settledFamilies\.filter/);

  const softStart = body.indexOf("isSoftGdiTryAddFirst(font.family)");
  const softBlock = body.slice(softStart, softStart + 1600);
  const setPendingAt = softBlock.indexOf("withPending([...s.pendingActivate, id])");
  const setSettledAt = softBlock.indexOf("withSettled(s.settledFamilies.filter");
  const clearAt = softBlock.indexOf("await clearSessionGdiRefused(font.family)");
  assert.ok(setPendingAt >= 0 && setSettledAt >= 0 && clearAt >= 0);
  assert.ok(
    setPendingAt < clearAt && setSettledAt < clearAt,
    "pending + Settled-drop before await clearSessionGdiRefused (close double-click race)",
  );
  // Same synchronous set() — both helpers appear before the async IIFE.
  const syncSetEnd = softBlock.indexOf("void (async () =>");
  assert.ok(syncSetEnd > setPendingAt && syncSetEnd > setSettledAt);
  assert.ok(
    !softBlock.slice(syncSetEnd).includes("withPending([...s.pendingActivate, id])"),
    "no second pending set after clear (pending already set sync)",
  );
  // After clear: still pending → sync; abort if pending cleared / Live / pending-off.
  assert.match(softBlock, /!st\.pendingSet\.has\(id\)/);
  assert.match(softBlock, /syncFontOnSystem\(font, true\)/);
  const syncIdx = softBlock.indexOf("syncFontOnSystem(font, true)", clearAt);
  assert.ok(syncIdx > clearAt, "clear still before Activate sync");
});

test("P2 hygiene: gdi bar-clear tip assert uses idle ternary", () => {
  assert.match(osActivate, /current:\s*active \? \(p\.current\s*\?\?\s*""\) : ""/);
  // Literal production pattern in tip comment (not stale 1.0.187-only p.current ?? "").
  assert.match(gdiPurge, /current: active \? \(p\.current \?\? ""\) : ""/);
  assert.match(gdiPurge, /idle ternary/);
  assert.doesNotMatch(
    gdiPurge,
    /assert\.match\(osActivate, \/current:\\s\*p\\.current\\s\*\\?\\?\\s\*""\/\)/,
  );
  assert.match(barClear, /active \? \(pCurrent \?\? ""\) : ""/);
  assert.match(barClear, /current:\s*active \? \(p\.current\s*\?\?\s*""\) : ""/);
});

test("docs mark 206g Skye P2 race + bar-clear hygiene", () => {
  assert.match(readme, /1\.0\.206g/);
  assert.match(bugs, /1\.0\.206g/);
  assert.match(bugs, /pending|double-click|one-try|race/i);
  assert.match(bugs, /idle ternary|bar-clear|active \? \(p\.current/i);
});

test("no reopen: provenance / Repair / modal / wave0 / Gidugu-hard / Retry clear", () => {
  assert.match(activateRs, /\.settled-add-zero/);
  assert.match(activateRs, /fn soft_full_face_exclude_repair/);
  assert.match(activateRs, /KNOWN_GDI_SESSION_INCAPABLE/);
  assert.match(activateRs, /fn clear_session_gdi_refused\(family/);
  assert.match(activateRs, /fn soft_power_retry_clears_session_gdi_refuse_so_add_can_run/);
  assert.match(confirmDlg, /OK = all/);
  assert.match(confirmDlg, /Abort/);
  assert.match(activateToggle, /splitPreferRemainder/);
  const hard = activateRs.slice(
    activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE"),
    activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE") + 500,
  );
  assert.match(hard, /Gidugu/);
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
  const toggleStart = store.indexOf("toggleActivated: (id) =>");
  const body = store.slice(toggleStart, toggleStart + 3200);
  assert.match(body, /await clearSessionGdiRefused/);
  assert.doesNotMatch(
    body.slice(body.indexOf("clearSessionGdiRefused"), body.indexOf("clearSessionGdiRefused") + 900),
    /markLiveActivated/,
  );
});
