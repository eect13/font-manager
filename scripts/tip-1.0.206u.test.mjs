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
const desktopSettings = readFileSync(
  join(root, "src/components/font-studio/desktop-settings.tsx"),
  "utf8",
);
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const activateQueueSrc = readFileSync(
  join(root, "src/lib/fonts/activate-queue.mjs"),
  "utf8",
);
const gdiMirror = readFileSync(join(root, "src/lib/fonts/gdi-incapable.ts"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const mainRs = readFileSync(join(root, "src-tauri/src/main.rs"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");
const beforeBuild = readFileSync(join(root, "scripts/tauri-before-build.mjs"), "utf8");
const writeTipSha = readFileSync(join(root, "scripts/write-tip-sha.mjs"), "utf8");
const catalog = JSON.parse(
  readFileSync(join(root, "src/lib/fonts/google-catalog.json"), "utf8"),
);

function familyRow(name) {
  return catalog.families.find((f) => f[0] === name);
}

test("206u keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.207");
  assert.match(version, /1\.0\.207/);
  const tauri = JSON.parse(
    readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  assert.equal(tauri.version, "1.0.207");
});

test("docs mark 206u Fixed; VF-primary; Refresh Documents; tip-sha; no tip-install/pack", () => {
  assert.match(readme, /1\.0\.206u/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206u/);
  assert.match(bugs, /VF-primary|vars-only|vars only/i);
  assert.match(bugs, /sync_documents_vf_policy|Refresh Documents/i);
  assert.match(readme, /No tip-install/);
  assert.match(bugs, /No tip-install/);
  const uStart = bugs.indexOf("## Fixed in tip / 1.0.206u");
  assert.ok(uStart >= 0);
  const uSec = bugs.slice(uStart, bugs.indexOf("## Fixed in tip / 1.0.206t"));
  assert.doesNotMatch(uSec, /tip-install(?!\/pack)|APPROVE FOR PACK/i);
  assert.match(uSec, /TIP_SHA|write-tip-sha|provenance/i);
  assert.match(uSec, /206t|#185|useShallow/i);
});

test("A) register VF-only when intact VF; fallback statics; dual-VF + denylist gates", () => {
  assert.match(activateRs, /fn dir_vf_primary_ready/);
  assert.match(activateRs, /fn family_any_dir_vf_primary/);
  assert.match(activateRs, /RegisterFaceMode::VarsOnly/);
  assert.match(activateRs, /RegisterFaceMode::AllIntactFallback/);
  assert.match(activateRs, /family_expects_dual_variable/);
  assert.match(activateRs, /family_has_no_public_vf/);
  assert.match(activateRs, /dir_vf_primary_ready_respects_dual_vf_and_denylist/);
  // Inter catalog-variable; Poppins static-only.
  const inter = familyRow("Inter");
  const poppins = familyRow("Poppins");
  assert.ok(inter, "Inter in catalog");
  assert.ok(poppins, "Poppins in catalog");
  assert.equal(inter[4], true, "Inter variable");
  assert.equal(poppins[4], false, "Poppins not variable");
});

test("A/P1) purge only after VarsOnly Add>0 (keep statics for fallback)", () => {
  assert.match(activateRs, /fn commit_vf_primary_after_successful_add/);
  assert.match(activateRs, /fn merge_variable_into_planned_keys_keep_statics/);
  assert.match(activateRs, /purge_after_successful_vf_add_ordering_keep_statics_until_commit/);
  // register path: commit only inside n > 0 after VarsOnly
  const reg = activateRs.slice(
    activateRs.indexOf("fn register_intact_family_detailed"),
    activateRs.indexOf("fn register_intact_family_detailed") + 2500,
  );
  assert.match(reg, /RegisterFaceMode::VarsOnly/);
  assert.match(reg, /commit_vf_primary_after_successful_add/);
  assert.match(reg, /AllIntactFallback/);
  // fetch must NOT skip statics via vf_complete
  assert.doesNotMatch(
    activateRs,
    /let vf_complete = !var_files\.is_empty/,
    "must not skip static fetch before Add",
  );
  assert.match(
    activateRs,
    /always fetch static instances alongside VF until VarsOnly/,
  );
  // adopt must not purge
  const adopt = activateRs.slice(
    activateRs.indexOf("fn adopt_variable_files_into_plan"),
    activateRs.indexOf("fn adopt_variable_files_into_plan") + 1200,
  );
  assert.doesNotMatch(adopt, /purge_redundant_statics_in_dir/);
  assert.match(adopt, /merge_variable_into_planned_keys_keep_statics/);
});

test("B) planned vars-only after successful Add; keep_statics pre-Add", () => {
  assert.match(activateRs, /merge_variable_into_planned_vars_only_when_vf_present/);
  assert.match(activateRs, /fn merge_variable_into_planned_keys_keep_statics/);
  assert.match(activateRs, /if !keys\.is_empty\(\) \{\s*return keys;/);
});

test("C) purge redundant statics + gdi-maps; keep VF", () => {
  assert.match(activateRs, /fn purge_redundant_statics_in_dir/);
  assert.match(activateRs, /fn purge_redundant_statics_for_family/);
  assert.match(activateRs, /gdi_map_dest_for/);
  assert.match(activateRs, /purge_redundant_statics_keeps_vf_deletes_statics/);
});

test("C/P1) Finlandica dual-VF = Text + Headline (not bare Finlandica)", () => {
  const dual = activateRs.slice(
    activateRs.indexOf("fn family_expects_dual_variable"),
    activateRs.indexOf("fn family_expects_dual_variable") + 500,
  );
  assert.match(dual, /Finlandica Text/);
  assert.match(dual, /Finlandica Headline/);
  assert.doesNotMatch(
    dual,
    /eq_ignore_ascii_case\("Finlandica"\)/,
    "bare Finlandica must not be dual-VF gate",
  );
  assert.match(activateRs, /Finlandica Text/);
  assert.match(activateRs, /Finlandica Headline/);
  const ft = familyRow("Finlandica Text");
  const fh = familyRow("Finlandica Headline");
  assert.ok(ft && ft[4] === true, "Finlandica Text catalog-variable");
  assert.ok(fh && fh[4] === true, "Finlandica Headline catalog-variable");
});

test("D) Refresh Documents sync command + UI (progress/cancel/testid)", () => {
  assert.match(activateRs, /fn sync_documents_vf_policy|pub fn sync_documents_vf_policy/);
  assert.match(mainRs, /sync_documents_vf_policy/);
  assert.match(osActivate, /syncDocumentsVfPolicy/);
  assert.match(activateToggle, /RefreshDocumentsMenuItem/);
  assert.match(activateToggle, /data-testid="refresh-documents"/);
  assert.match(activateToggle, /aria-label="Refresh Documents folder"/);
  assert.match(desktopSettings, /data-testid="refresh-documents-settings"/);
  assert.match(activateToggle, /Removes redundant statics when a variable font is present/);
  assert.match(osActivate, /cancel_google_downloads|cancelDownloadQueue/);
  assert.match(activateToggle, /syncDocumentsVfPolicy/);
  assert.match(activateToggle, /syncManagedDocumentsRoot/);
});

test("D/P2) Settings locked toast + Cancel mid-Refresh context toast", () => {
  // Settings mirrors Library Repair locked hint.
  assert.match(
    desktopSettings,
    /locked — deactivate fonts or quit Adobe\/Word, then Repair/,
  );
  assert.match(desktopSettings, /sync-docs-vf-locked/);
  assert.match(activateToggle, /sync-docs-vf-locked/);
  // Cancel mid-Refresh: sticky wasDocs owns Documents refresh cancelled (no Download cancelled).
  assert.match(osActivate, /docsVfSyncActive/);
  assert.match(osActivate, /docsVfSyncCancelPending|wasDocsVfSync/);
  assert.match(osActivate, /docsVfSyncOwnsJob|Documents refresh cancelled|docs-cancel/);
  assert.match(activateToggle, /Documents refresh cancelled/);
  const cancel = osActivate.slice(
    osActivate.indexOf("export function cancelDownloadQueue("),
    osActivate.indexOf("export function pauseDownloadQueue"),
  );
  assert.match(cancel, /wasDocsVfSync/);
  // 1.0.206w amend: cancelDownloadQueue suppresses Download cancelled; callers toast on Rust cancelled.
  assert.doesNotMatch(cancel, /Documents refresh cancelled/);
  assert.match(cancel, /if \(wasDocsVfSync\) \{[\s\S]*?return;/);
  assert.match(activateToggle, /Documents refresh cancelled/);
  assert.match(desktopSettings, /Documents refresh cancelled/);
  const earlyReturn = cancel.search(/if \(wasDocsVfSync\) \{[\s\S]*?return;/);
  const downloadToastAt = cancel.indexOf('"Download cancelled"');
  assert.ok(earlyReturn >= 0 && downloadToastAt > earlyReturn);
});

test("E) Activate remaining aria-label matches visible text", () => {
  const start = activateToggle.indexOf("export function ActivateMenuItem");
  assert.ok(start >= 0);
  const next = activateToggle.indexOf("\nexport function ", start + 1);
  const body = activateToggle.slice(start, next < 0 ? undefined : next);
  assert.match(body, /activateLabel/);
  assert.match(body, /aria-label=\{activateLabel/);
  assert.match(
    activateToggle,
    /aria-label=\{\s*remaining && remaining < count\s*\?\s*`Activate remaining/,
  );
});

test("206t #185 / useShallow kept", () => {
  const av = activateToggle.indexOf("export function ActivateVisibleMenuItem");
  const next = activateToggle.indexOf("\nexport function ", av + 1);
  const body = activateToggle.slice(av, next < 0 ? undefined : next);
  assert.match(body, /const visibleCount = useFontStore\(/);
  assert.match(body, /return n/);
  const lib = activateToggle.slice(
    activateToggle.indexOf("export function LibraryActivateMenuItem"),
    activateToggle.indexOf("export function ActivatedDeactivateMenuItem"),
  );
  assert.match(lib, /useShallow\(\s*\(?\s*s\s*\)?\s*=>\s*\[/);
});

test("tip-install provenance: write-tip-sha.mjs + before-build stamp", () => {
  assert.ok(existsSync(join(root, "scripts/write-tip-sha.mjs")));
  assert.match(writeTipSha, /TIP_SHA\.txt/);
  assert.match(beforeBuild, /write-tip-sha\.mjs/);
});

test("standing locks: Live=Add>0 / Settled / Gidugu-hard / soft emoji / no parallel Add / no Off-at-spawn", () => {
  assert.equal(KNOWN_GDI_SESSION_INCAPABLE.length, 1);
  assert.equal(KNOWN_GDI_SESSION_INCAPABLE[0].family, "Gidugu");
  assert.equal(isKnownGdiSessionIncapable("Gidugu"), true);
  assert.match(gdiMirror, /SOFT_GDI_TRY_ADD_FIRST/);
  assert.doesNotMatch(activateToggle, /Worker|Atomics|parallelAdd|FR_PRIVATE/);
  assert.doesNotMatch(activateQueueSrc, /FR_PRIVATE/);
  const start = osActivate.indexOf("if (!on) {");
  assert.ok(start >= 0);
  const body = osActivate.slice(
    start,
    osActivate.indexOf("const google = fonts.filter", start),
  );
  assert.match(body, /Do NOT confirm all Off here/);
  assert.doesNotMatch(body, /confirmDeactivated\(fonts\.map/);
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
