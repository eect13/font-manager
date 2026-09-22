import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const confirmTs = readFileSync(join(root, "src/lib/fonts/activate-confirm.ts"), "utf8");
const confirmDlg = readFileSync(
  join(root, "src/components/font-studio/activate-confirm-dialog.tsx"),
  "utf8",
);
const store = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
const fontCard = readFileSync(join(root, "src/components/font-studio/font-card.tsx"), "utf8");
const appShell = readFileSync(join(root, "src/components/font-studio/app-shell.tsx"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");

test("206e keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("P1 soft Settled requires .settled-add-zero provenance", () => {
  assert.match(activateRs, /\.settled-add-zero/);
  assert.match(activateRs, /fn stamp_settled_add_zero_provenance/);
  assert.match(activateRs, /fn wipe_soft_complete_lacking_provenance/);
  assert.match(activateRs, /fn soft_scan_settled_from_provenance/);
  assert.match(activateRs, /stamp_settled_add_zero_provenance\(dir\)/);
  const scanStart = activateRs.indexOf("pub fn scan_disk_families");
  const scan = activateRs.slice(scanStart, scanStart + 4500);
  assert.match(scan, /wipe_soft_complete_lacking_provenance/);
  assert.match(scan, /soft_scan_settled_from_provenance/);
  assert.match(scan, /dir_has_settled_add_zero_provenance/);
  // Must NOT treat bare has_complete alone as soft Settled.
  assert.doesNotMatch(
    scan.slice(scan.indexOf("} else if soft"), scan.indexOf("} else if soft") + 400),
    /has_complete\s*&&\s*soft_emoji_full_face_ok/,
  );
});

test("P1 soft full-face without provenance ≠ Incomplete / Repair", () => {
  assert.match(activateRs, /fn soft_full_face_exclude_repair/);
  assert.match(activateRs, /fn soft_scan_incomplete/);
  assert.match(activateRs, /fn family_soft_full_face_exclude_repair/);
  assert.match(activateRs, /family_soft_full_face_exclude_repair\(app, family\)/);
  assert.match(activateRs, /soft_full_face_exclude_repair\(dir, name\)/);
  assert.match(activateRs, /soft_settled_requires_provenance_not_bare_complete/);
});

test("P2 soft session refuse after Add=0; early-skip soft via refuse only", () => {
  assert.match(activateRs, /fn family_early_skip_soft_session_refused/);
  assert.match(activateRs, /family_early_skip_soft_session_refused\(app, family\)/);
  const note = activateRs.slice(
    activateRs.indexOf("fn note_session_gdi_refused"),
    activateRs.indexOf("fn note_session_gdi_refused") + 400,
  );
  assert.match(note, /family_may_settle_add_zero/);
  const settleFn = activateRs.slice(
    activateRs.indexOf("fn stamp_settle_after_add_zero"),
    activateRs.indexOf("fn stamp_settle_after_add_zero") + 500,
  );
  assert.match(settleFn, /note_session_gdi_refused\(family\)/);
});

test("P2 Power: hard Settled no-op; soft Settled Retry Add once", () => {
  const toggleStart = store.indexOf("toggleActivated: (id) =>");
  const body = store.slice(toggleStart, toggleStart + 1800);
  assert.match(body, /isKnownGdiSessionIncapable\(font\.family\)/);
  assert.match(body, /isSoftGdiTryAddFirst\(font\.family\)/);
  assert.match(body, /softSettledRetryTried/);
  assert.match(body, /hard Settled/);
  assert.match(body, /Retry Add/);
  assert.match(fontCard, /settledPowerTitle/);
  assert.match(fontCard, /Retry Add \(one try/);
});

test("P2 in-app modal OK/Cancel/Abort; no window.confirm; wave0 prefer", () => {
  assert.doesNotMatch(activateToggle, /window\.confirm/);
  assert.match(activateToggle, /requestActivateConfirm/);
  assert.match(activateToggle, /splitPreferRemainder/);
  assert.match(activateToggle, /Wave0|wave0|\(first\)/);
  assert.match(confirmTs, /ActivateConfirmChoice/);
  assert.match(confirmTs, /"ok" \| "cancel" \| "abort"/);
  assert.match(confirmDlg, /OK = all/);
  assert.match(confirmDlg, /Abort/);
  assert.match(confirmDlg, /Cancel [·=].*visible|Cancel [·=].*first page|Cancel [·=].*keep first|already queued/);
  assert.match(appShell, /ActivateConfirmDialog/);
});

test("P3 Cancel offers first-page/selection when visible=0; soften ETA; docs 206e", () => {
  assert.match(activateToggle, /first page \/ selection|cancelIds/);
  assert.match(activateToggle, /Large Activate All can take a while/);
  assert.doesNotMatch(activateToggle, /~\d+\+ minutes/);
  assert.match(readme, /1\.0\.206e/);
  assert.match(bugs, /1\.0\.206e/);
  assert.match(bugs, /settled-add-zero|provenance/i);
});
