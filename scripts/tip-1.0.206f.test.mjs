import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const store = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const mainRs = readFileSync(join(root, "src-tauri/src/main.rs"), "utf8");
const perms = readFileSync(join(root, "src-tauri/permissions/font-activate.toml"), "utf8");
const fontCard = readFileSync(join(root, "src/components/font-studio/font-card.tsx"), "utf8");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const confirmDlg = readFileSync(
  join(root, "src/components/font-studio/activate-confirm-dialog.tsx"),
  "utf8",
);
const confirmTs = readFileSync(join(root, "src/lib/fonts/activate-confirm.ts"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");
const barClear = readFileSync(join(root, "scripts/settled-idle-bar-clear.test.mjs"), "utf8");

test("206f keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("P1 soft Retry clears session_gdi_refused before Activate", () => {
  assert.match(activateRs, /fn clear_session_gdi_refused\(family/);
  assert.match(activateRs, /pub fn clear_session_gdi_refused_family/);
  assert.match(activateRs, /fn soft_early_skip_from_session_refuse/);
  assert.match(activateRs, /fn soft_retry_allows_add_after_clear/);
  assert.match(activateRs, /fn soft_power_retry_clears_session_gdi_refuse_so_add_can_run/);
  const unit = activateRs.slice(
    activateRs.indexOf("fn soft_power_retry_clears_session_gdi_refuse_so_add_can_run"),
    activateRs.indexOf("fn soft_power_retry_clears_session_gdi_refuse_so_add_can_run") + 1600,
  );
  assert.match(unit, /note_session_gdi_refused\(fam\)/);
  assert.match(unit, /clear_session_gdi_refused\(fam\)/);
  assert.match(unit, /family_session_gdi_refused\(fam\)/);
  assert.match(unit, /soft_retry_allows_add_after_clear\(true, true\)/);
  assert.match(unit, /soft_early_skip_from_session_refuse/);

  assert.match(mainRs, /clear_session_gdi_refused_family/);
  assert.match(perms, /clear_session_gdi_refused_family/);
  assert.match(osActivate, /export async function clearSessionGdiRefused/);
  assert.match(osActivate, /clear_session_gdi_refused_family/);

  const toggleStart = store.indexOf("toggleActivated: (id) =>");
  const body = store.slice(toggleStart, toggleStart + 2800);
  assert.match(body, /clearSessionGdiRefused\(font\.family\)/);
  assert.match(body, /await clearSessionGdiRefused/);
  assert.match(body, /softSettledRetryTried/);
  const clearAt = body.indexOf("await clearSessionGdiRefused");
  const syncAt = body.indexOf("syncFontOnSystem(font, true)", clearAt);
  assert.ok(clearAt >= 0 && syncAt > clearAt, "clear before Activate sync");
});

test("P1 keep soft early-skip + hard no-op; Live=Add>0 only after Retry", () => {
  assert.match(activateRs, /fn family_early_skip_soft_session_refused/);
  assert.match(activateRs, /family_early_skip_soft_session_refused\(app, family\)/);
  const toggleStart = store.indexOf("toggleActivated: (id) =>");
  const body = store.slice(toggleStart, toggleStart + 2800);
  assert.match(body, /isKnownGdiSessionIncapable\(font\.family\)/);
  assert.match(body, /hard Settled/);
  // Soft Retry must not mark Live in the clear path — syncFontOnSystem → Add>0 only.
  assert.doesNotMatch(body.slice(body.indexOf("clearSessionGdiRefused"), body.indexOf("clearSessionGdiRefused") + 900), /markLiveActivated/);
  assert.match(activateRs, /settled_implies_not_activated|gdi_faces_added == 0/);
});

test("P4 Cancel/wave0 copy honesty: keep prefer if queued else visible/first-page", () => {
  // 1.0.206h shortened Cancel labels; semantics unchanged (keep first / visible / first page).
  assert.match(confirmDlg, /Cancel [·=].*keep first|Cancel · keep first/);
  assert.match(confirmDlg, /Cancel [·=].*visible|Cancel · visible/);
  assert.match(confirmDlg, /Cancel [·=].*first page|Cancel · first page/);
  assert.match(confirmDlg, /preferCount > 0/);
  assert.match(confirmTs, /keep prefer if wave0 queued/);
  const actStart = activateToggle.indexOf("export function activateSet");
  const act = activateToggle.slice(actStart, actStart + 3600);
  assert.match(act, /cancelLabel/);
  assert.match(act, /\(first page\)/);
  assert.match(act, /\(visible\)/);
  // Prefer already wave0: Cancel must not re-label as visible-only enqueue.
  assert.match(act, /Prefer already wave0/);
});

test("P5 soft Settled Power tooltip Retry once; after used = not Live", () => {
  assert.match(store, /export function softSettledRetryAlreadyTried/);
  assert.match(fontCard, /softSettledRetryAlreadyTried\(font\.family\)/);
  assert.match(fontCard, /Retry Add \(one try this process\)/);
  assert.match(fontCard, /Retry already used this process \(not Live\)/);
  assert.match(fontCard, /settledPowerTitle/);
});

test("P3 bar-clear tip asserts idle current clear (1.0.187/204)", () => {
  // Optional: tip assert locks the production pattern (not a stale 1.0.187-only merge).
  assert.match(osActivate, /current:\s*active \? \(p\.current\s*\?\?\s*""\) : ""/);
  assert.match(barClear, /active \? \(pCurrent \?\? ""\) : ""/);
  assert.match(barClear, /current:\s*active \? \(p\.current\s*\?\?\s*""\) : ""/);
});

test("docs mark 206f Skye soft Retry + Cancel/tooltip honesty", () => {
  assert.match(readme, /1\.0\.206f/);
  assert.match(bugs, /1\.0\.206f/);
  assert.match(bugs, /session_gdi_refused|clear_session_gdi_refused/i);
  assert.match(bugs, /already queued|keep first|Cancel/i);
});

test("no reopen: provenance / Repair exclude / modal / Gidugu-hard still present", () => {
  assert.match(activateRs, /\.settled-add-zero/);
  assert.match(activateRs, /fn soft_full_face_exclude_repair/);
  assert.match(activateRs, /KNOWN_GDI_SESSION_INCAPABLE/);
  assert.match(confirmDlg, /OK = all/);
  assert.match(confirmDlg, /Abort/);
  assert.match(activateToggle, /splitPreferRemainder/);
  const hard = activateRs.slice(
    activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE"),
    activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE") + 500,
  );
  assert.match(hard, /Gidugu/);
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
});
