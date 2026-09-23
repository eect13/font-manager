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
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
  const tauri = JSON.parse(
    readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  assert.equal(tauri.version, "1.0.206");
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

test("B) download/planned vars-only when VF complete (no static backup)", () => {
  assert.match(activateRs, /merge_variable_into_planned_vars_only_when_vf_present/);
  assert.match(activateRs, /VF-primary: when intact VF/);
  assert.match(activateRs, /vf_complete/);
  assert.match(activateRs, /planned = \*\*vars only\*\*|vars-only when|VF-primary.*vars only/i);
  // Doc comment above merge must declare VF-primary vars-only (not statics-as-backup).
  const mergeAt = activateRs.indexOf("fn merge_variable_into_planned_keys");
  assert.ok(mergeAt > 0);
  const mergeDoc = activateRs.slice(Math.max(0, mergeAt - 400), mergeAt + 500);
  assert.match(mergeDoc, /VF-primary|vars only/i);
  assert.doesNotMatch(mergeDoc, /statics stay|never var-only/);
  assert.match(activateRs, /if !keys\.is_empty\(\) \{\s*return keys;/);
});

test("C) purge redundant statics + gdi-maps; keep VF", () => {
  assert.match(activateRs, /fn purge_redundant_statics_in_dir/);
  assert.match(activateRs, /fn purge_redundant_statics_for_family/);
  assert.match(activateRs, /gdi_map_dest_for/);
  assert.match(activateRs, /purge_redundant_statics_keeps_vf_deletes_statics/);
  assert.match(activateRs, /Do NOT delete|VF must remain|keeps_vf/i);
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

test("E) Activate remaining aria-label matches visible text", () => {
  const start = activateToggle.indexOf("export function ActivateMenuItem");
  assert.ok(start >= 0);
  const next = activateToggle.indexOf("\nexport function ", start + 1);
  const body = activateToggle.slice(start, next < 0 ? undefined : next);
  assert.match(body, /activateLabel/);
  assert.match(body, /aria-label=\{activateLabel/);
  // Catalog + Library use expression aria matching remaining ternary.
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
