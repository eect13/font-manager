import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hydrate = readFileSync(join(root, "src/lib/fonts/hydrate.ts"), "utf8");
const store = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const gdiMirror = readFileSync(join(root, "src/lib/fonts/gdi-incapable.ts"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");

/** Extract `family: "…"` / `family: "…"` entries from a named table body. */
function tableFamilies(src, tableName, endMarker) {
  const start = src.indexOf(tableName);
  assert.ok(start >= 0, `missing ${tableName}`);
  const slice = endMarker
    ? src.slice(start, src.indexOf(endMarker, start))
    : src.slice(start, start + 800);
  const names = [...slice.matchAll(/family:\s*"([^"]+)"/g)].map((m) => m[1]);
  return names;
}

test("206d keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.207");
  assert.match(version, /1\.0\.207/);
});

test("P1 Scan soft settled: soft + provenance reports settled; no soft early-skip on hard path", () => {
  // 206e: Settled requires `.settled-add-zero` (not bare `.complete`). Still no soft auto-stamp on Scan.
  const scanStart = activateRs.indexOf("pub fn scan_disk_families");
  assert.ok(scanStart >= 0);
  const scan = activateRs.slice(scanStart, scanStart + 4500);
  assert.match(scan, /family_soft_try_add_then_settle/);
  assert.match(scan, /has_complete/);
  assert.match(scan, /soft_emoji_full_face_ok/);
  assert.match(scan, /soft_scan_settled_from_provenance|settled-add-zero|dir_has_settled_add_zero_provenance/);
  assert.match(scan, /never bare|wipe_soft_complete_lacking_provenance|Add=0 provenance/i);
  // Soft must NOT use hard-only early-skip path for Activate.
  assert.match(activateRs, /fn family_early_skip_known_incapable/);
  const early = activateRs.slice(
    activateRs.indexOf("fn family_early_skip_known_incapable"),
    activateRs.indexOf("fn family_early_skip_known_incapable") + 600,
  );
  assert.match(early, /family_known_gdi_session_incapable/);
  assert.doesNotMatch(early, /family_soft_try_add_then_settle|is_emoji_session_family/);
});

test("P1 applyDiskStatusHonesty seeds soft Settled from Scan rows only", () => {
  const start = store.indexOf("applyDiskStatusHonesty: (rows) =>");
  assert.ok(start >= 0);
  const body = store.slice(start, start + 1200);
  assert.match(body, /if \(row\.settled\) settledNames\.push/);
  assert.match(body, /for \(const e of KNOWN_GDI_SESSION_INCAPABLE\)/);
  assert.doesNotMatch(body, /SOFT_GDI_TRY_ADD_FIRST/);
  assert.match(body, /Soft emoji Settled comes from Scan rows/);
});

test("P1 soft allowlist TS↔Rust exact parity (not string-presence only)", () => {
  // Use `export const` / `const SOFT_…` so comment mentions of the name are skipped.
  const tsSoft = tableFamilies(
    gdiMirror,
    "export const SOFT_GDI_TRY_ADD_FIRST",
    "export function isKnownGdiSessionIncapable",
  );
  const rsSoft = tableFamilies(
    activateRs,
    "const SOFT_GDI_TRY_ADD_FIRST: &[KnownGdiIncapableEntry]",
    "fn soft_gdi_try_add_entry",
  );
  assert.deepEqual(tsSoft, ["Noto Color Emoji", "Noto Emoji"]);
  assert.deepEqual(rsSoft, tsSoft);
  assert.deepEqual(rsSoft, ["Noto Color Emoji", "Noto Emoji"]);

  const tsHard = tableFamilies(
    gdiMirror,
    "export const KNOWN_GDI_SESSION_INCAPABLE",
    "export const SOFT_GDI_TRY_ADD_FIRST",
  );
  const rsHard = tableFamilies(
    activateRs,
    "const KNOWN_GDI_SESSION_INCAPABLE: &[KnownGdiIncapableEntry]",
    "fn known_gdi_incapable_entry",
  );
  assert.deepEqual(tsHard, ["Gidugu"]);
  assert.deepEqual(rsHard, tsHard);

  assert.match(activateRs, /fn is_emoji_session_family/);
  assert.match(
    activateRs.slice(
      activateRs.indexOf("fn is_emoji_session_family"),
      activateRs.indexOf("fn is_emoji_session_family") + 280,
    ),
    /soft_gdi_try_add_entry/,
  );
});

test("Activate All includes emoji ids (not hard-skip); hard Gidugu only", () => {
  assert.match(hydrate, /KNOWN_GDI_SESSION_INCAPABLE\.map\(\(e\) => e\.family\)/);
  assert.doesNotMatch(hydrate, /SOFT_GDI_TRY_ADD_FIRST/);
  // 1.0.206q: hard skip via activateQueueIds / gdi-incapable SoT; toggle must not soft-hard-skip.
  assert.match(activateToggle, /activateQueueIds/);
  const queueMod = readFileSync(join(root, "src/lib/fonts/activate-queue.mjs"), "utf8");
  assert.match(queueMod, /isKnownGdiSessionIncapable/);
  assert.doesNotMatch(activateToggle, /isSoftGdiTryAddFirst/);
  const hard = gdiMirror.slice(
    gdiMirror.indexOf("KNOWN_GDI_SESSION_INCAPABLE"),
    gdiMirror.indexOf("SOFT_GDI_TRY_ADD_FIRST"),
  );
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
});

test("P2 soft confirm Cancel = visible path (in-app modal since 206e)", () => {
  // 206e: window.confirm → in-app OK/Cancel/Abort; Cancel still prefers visible (or first-page).
  const actStart = activateToggle.indexOf("export function activateSet");
  const act = activateToggle.slice(actStart, actStart + 3200);
  assert.doesNotMatch(act, /window\.confirm/);
  assert.match(act, /requestActivateConfirm|cancelIds/);
  assert.match(act, /orderActivateIds\(visibleIds|cancelIds/);
  assert.match(act, /\(visible\)/);
  assert.doesNotMatch(act, /Cancel = abort` \+/);
});

test("P2 Noto Emoji stub reject parity (≥256KB) color + outline", () => {
  assert.match(activateRs, /emoji_stub_gate/);
  assert.match(activateRs, /slug == "noto-emoji"/);
  assert.match(activateRs, /fn soft_emoji_full_face_ok/);
  assert.match(osActivate, /outlineEmoji/);
  assert.match(osActivate, /softEmojiStubGate/);
  assert.match(osActivate, /NotoEmoji-Regular\.ttf/);
  assert.match(osActivate, /softEmojiStubGate && data\.byteLength < 256 \* 1024/);
});

test("P2 firstSettledAllowlistedFamily includes soft; toast wired", () => {
  assert.match(gdiMirror, /isSoftGdiTryAddFirst\(n\)/);
  assert.match(osActivate, /firstSettledAllowlistedFamily\(settledNames\)/);
  assert.doesNotMatch(osActivate, /label: "Try Fontsource"/);
});

test("docs note 206d Skye pre-ship fixes", () => {
  assert.match(readme, /1\.0\.206d/);
  assert.match(bugs, /1\.0\.206d/);
  assert.match(bugs, /Scan soft|soft settle|SOFT_GDI_TRY_ADD_FIRST/i);
});
